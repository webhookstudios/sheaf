import GLib from 'gi://GLib';
import Graphene from 'gi://Graphene';
import Meta from 'gi://Meta';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {TabBar} from './tabBar.js';

const MIN_HEIGHT_AFTER_SHRINK = 120;
// Where a tab pulled out of the bar is held, relative to its window's
// top-left corner: roughly where a title bar would be grabbed.
const DETACH_GRAB_X = 150;
const DETACH_GRAB_Y = 16;
// How long to wait for an app to take up a rectangle we asked for before
// correcting its geometry again.
const REQUEST_TIMEOUT_MS = 400;
// How long the active window must be left alone before its state is
// corrected.
const SETTLE_DELAY_MS = 120;

function sameRect(a, b) {
    return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

function copyRect({x, y, width, height}) {
    return {x, y, width, height};
}

// Move a hidden tab onto `rect`. Hidden tabs are never left maximized or
// fullscreen: they would ignore the move, and an invisible fullscreen
// window still hides the top bar.
function place(window, rect) {
    if (window.is_fullscreen())
        window.unmake_fullscreen();
    if (window.is_maximized())
        window.unmaximize();
    // Placed as a user move: otherwise the compositor pulls the window back
    // on screen when the group has been dragged partly off it.
    if (!sameRect(window.get_frame_rect(), rect))
        window.move_resize_frame(true, rect.x, rect.y, rect.width, rect.height);
}

// Hand `window` to the compositor's own move drag, continuing from the
// pointer press that produced `event`.
function dragWindow(window, event) {
    const [x, y] = event.get_coords();
    const sprite = global.stage.get_context().get_backend()
        .get_sprite(global.stage, event);
    Main.activateWindow(window);
    window.begin_grab_op(Meta.GrabOp.MOVING, sprite, event.get_time(),
        new Graphene.Point({x, y}));
}

// A set of windows that share one rectangle. Only the active window is
// visible; the others sit at the same rectangle with their actor fully
// transparent, so they never show through or around the active one.
//
// The tab bar is a child of the active window's actor, placed just above the
// window frame. That makes it move, stack, minimize and switch workspace with
// the window for free.
//
// The group follows whatever happens to its active window: geometry,
// minimizing and workspace. Two states need correcting rather than
// following, because the bar needs room above the window:
//   - maximized: turned into "fill the work area below the bar"
//   - touching the top of the work area (edge tiling): nudged down
// Both are done in _settle(), once the window has stopped changing.
//
// The extension is told about membership through three callbacks:
//   onChanged()         tabs were added, removed or reordered
//   onReleased(window)  a window left the group and is still open
//   onDissolved(group)  the group is gone
export class Group {
    constructor({barHeight, colors, minSize, getAddable, addWindows,
        onChanged, onReleased, onDissolved}) {
        this.windows = [];
        this.active = null;
        // Set by the extension while the active window is in a pointer move
        // or resize, so nothing is corrected under the user's hand.
        this.dragging = false;
        // The group dissolves when it has fewer windows than this: 2
        // normally, 1 when every window gets a tab bar.
        this.minSize = minSize;

        this._barHeight = barHeight;
        this._onChanged = onChanged;
        this._onReleased = onReleased;
        this._onDissolved = onDissolved;
        // The shared rectangle: the active window's frame the last time it
        // was neither maximized nor fullscreen.
        this._rect = null;
        // Where to go back to when a filled group is "maximized" again.
        this._restoreRect = null;
        // A rectangle requested from the active window that it has not taken
        // up yet, as {rect, expires}.
        this._request = null;
        // The top-edge position ensureBarRoom() last tried to fix.
        this._nudgedFrom = null;
        this._settleId = 0;
        this._syncingState = false;
        this._actors = new Map();
        this._bar = new TabBar({
            onActivate: window => this.activate(window),
            onClose: window => window.delete(global.get_current_time()),
            onReorder: (window, index) => this._reorder(window, index),
            onDetach: (window, event) => this._detach(window, event),
            onMove: event => dragWindow(this.active, event),
            getAddable: () => getAddable(this),
            onAdd: windows => addWindows(this, windows),
        }, colors);
    }

    setAppearance({barHeight, colors}) {
        this._barHeight = barHeight;
        this._bar.setColors(colors);
        this._syncBar();
        this.queueSettle();
    }

    // Height of the strip above the visible window that belongs to this
    // group, or 0 while the bar is hidden.
    get barHeight() {
        return this._bar?.visible ? this._barHeight : 0;
    }

    has(window) {
        return this.windows.includes(window);
    }

    // The first window added defines the group's rectangle and becomes
    // active. Later windows join hidden; call setActive() to show one.
    add(window) {
        if (this.has(window))
            return;

        // A window joining from elsewhere (the "+" menu lists every
        // workspace) comes to where the group is.
        if (this.active) {
            const workspace = this.active.get_workspace();
            if (workspace && !this.active.is_on_all_workspaces() &&
                !window.is_on_all_workspaces() && window.get_workspace() !== workspace)
                window.change_workspace(workspace);
            if (window.minimized && !this.active.minimized)
                window.unminimize();
        }

        this.windows.push(window);
        window.connectObject(
            'unmanaged', () => this.remove(window, {closing: true}),
            'position-changed', () => this._onGeometryChanged(window),
            'size-changed', () => this._onGeometryChanged(window),
            'notify::fullscreen', () => this._onGeometryChanged(window),
            'notify::minimized', () => this._onMinimizedChanged(window),
            'workspace-changed', () => this._onWorkspaceChanged(window),
            this);

        const actor = window.get_compositor_private();
        if (actor) {
            this._actors.set(window, actor);
            // The shell's own animations (minimize, unminimize, map) end by
            // making the actor opaque again, which would reveal a hidden tab.
            actor.connectObject('notify::opacity', () => {
                if (window !== this.active && actor.opacity !== 0)
                    actor.opacity = 0;
            }, this);
        }
        this._bar.addTab(window);

        if (!this.active) {
            this._rect = copyRect(window.get_frame_rect());
            this.setActive(window);
        } else {
            place(window, this._rect);
            this._setOpacity(window, 0);
        }
        this._onChanged();
    }

    // `refocus` hands keyboard focus to the tab that takes over when the
    // removed window was the one the user was working in. `closing` is set
    // when the window is going away, so it is not made visible for its
    // closing animation.
    remove(window, {refocus = true, closing = false} = {}) {
        const index = this.windows.indexOf(window);
        if (index < 0)
            return;

        this.windows.splice(index, 1);
        window.disconnectObject(this);
        this._actors.get(window)?.disconnectObject(this);
        if (!closing || window === this.active)
            this._setOpacity(window, 255);
        this._actors.delete(window);
        this._bar.removeTab(window);

        if (this.windows.length < this.minSize) {
            this.destroy();
        } else if (this.active === window) {
            // The bar lives on the old active actor, which is about to be
            // destroyed if the window closed. setActive() moves it.
            this.active = null;
            const next = this.windows[Math.min(index, this.windows.length - 1)];
            this.setActive(next);

            const focus = global.display.focus_window;
            if (refocus && (!focus || focus === window || this.has(focus)))
                Main.activateWindow(next);
        }

        this._onChanged();
        if (!closing)
            this._onReleased(window);
    }

    setActive(window) {
        if (!this.has(window) || this.active === window)
            return;

        const previous = this.active;
        this.active = window;
        this._request = null;
        this._nudgedFrom = null;
        if (previous) {
            this._setOpacity(previous, 0);
            place(previous, this._rect);
            place(window, this._rect);
        }
        this._setOpacity(window, 255);

        this._bar.get_parent()?.remove_child(this._bar);
        this._actors.get(window)?.add_child(this._bar);
        this._bar.setActiveTab(window);
        this._syncBar();
        this.queueSettle();
    }

    // Show `window` and give it keyboard focus.
    activate(window) {
        this.setActive(window);
        Main.activateWindow(window);
    }

    // Correct the active window's state once things are quiet. Safe to call
    // at any time. Each call restarts the wait, so this acts only after the
    // window has stopped changing: edge tiling, for one, places a window a
    // moment after the drag ends, and acting sooner would undo it.
    queueSettle() {
        if (!this._bar)
            return;
        if (this._settleId)
            GLib.source_remove(this._settleId);
        this._settleId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, SETTLE_DELAY_MS, () => {
            this._settleId = 0;
            this._settle();
            return GLib.SOURCE_REMOVE;
        });
    }

    destroy() {
        if (!this._bar)
            return;

        if (this._settleId)
            GLib.source_remove(this._settleId);
        this._settleId = 0;
        for (const window of this.windows) {
            window.disconnectObject(this);
            this._actors.get(window)?.disconnectObject(this);
            this._setOpacity(window, 255);
        }
        this._actors.clear();
        this.windows = [];
        this.active = null;
        this._bar.destroy();
        this._bar = null;
        this._onDissolved(this);
    }

    _setOpacity(window, opacity) {
        const actor = this._actors.get(window);
        if (actor)
            actor.opacity = opacity;
    }

    _settle() {
        const window = this.active;
        if (!window || this.dragging || window.minimized || window.is_fullscreen())
            return;

        // A rectangle we asked for is still on its way: correcting now
        // would act on a half-applied state and override it.
        if (this._request) {
            const {rect, expires, retried} = this._request;
            const arrived = sameRect(window.get_frame_rect(), rect);
            if (!arrived && GLib.get_monotonic_time() < expires)
                return;
            this._request = null;
            // Something else moved the window in the meantime (edge tiling
            // puts a window back on its tile when it is unmaximized). Ask
            // once more now that it has finished.
            if (!arrived && !retried && !window.is_maximized()) {
                this._requestRect(window, rect, true);
                return;
            }
        }

        if (window.is_maximized())
            this._toggleFill(window);
        else
            this._ensureBarRoom(window);
    }

    // Ask the active window to take up `rect`, and look again once it has
    // or the wait runs out. Any maximized state is dropped first: a fully
    // maximized window ignores the request, and edge tiling marks a
    // half-screen window as vertically maximized, which pins its top edge.
    _requestRect(window, rect, retried = false) {
        this._request = {
            rect: copyRect(rect),
            expires: GLib.get_monotonic_time() + REQUEST_TIMEOUT_MS * 1000,
            retried,
        };
        if (window.maximized_vertically || window.maximized_horizontally)
            window.unmaximize();
        window.move_resize_frame(true, rect.x, rect.y, rect.width, rect.height);
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, REQUEST_TIMEOUT_MS + 20, () => {
            this.queueSettle();
            return GLib.SOURCE_REMOVE;
        });
    }

    // A truly maximized window leaves no room for the bar. Maximizing a
    // group instead fills the work area below the bar; maximizing it again
    // goes back to where it was.
    _toggleFill(window) {
        const area = window.get_work_area_current_monitor();
        const fill = {
            x: area.x,
            y: area.y + this._barHeight,
            width: area.width,
            height: area.height - this._barHeight,
        };
        const filled = sameRect(this._rect, fill);
        const target = filled && this._restoreRect ? this._restoreRect : fill;
        if (!filled)
            this._restoreRect = copyRect(this._rect);

        this._requestRect(window, target);
    }

    // The bar sits above the window, so a window touching the top of the
    // work area (edge tiling, or dropped against the panel) would push it
    // off screen. Nudge the group down instead.
    _ensureBarRoom(window) {
        const area = window.get_work_area_current_monitor();
        const rect = window.get_frame_rect();
        const overlap = area.y + this._barHeight - rect.y;
        // Only the strip just under the panel; a window dragged far above
        // the work area is on another monitor's edge or off screen on
        // purpose.
        if (overlap <= 0 || overlap > this._barHeight) {
            this._nudgedFrom = null;
            return;
        }
        // The compositor refused the last nudge from here; don't loop.
        if (this._nudgedFrom && sameRect(rect, this._nudgedFrom))
            return;
        this._nudgedFrom = copyRect(rect);

        // Keep the size unless the window would now run off the bottom.
        const y = rect.y + overlap;
        const room = area.y + area.height - y;
        const height = Math.max(Math.min(rect.height, room),
            Math.min(rect.height, MIN_HEIGHT_AFTER_SHRINK));
        this._requestRect(window, {x: rect.x, y, width: rect.width, height});
    }

    _reorder(window, index) {
        const from = this.windows.indexOf(window);
        if (from < 0)
            return;
        this.windows.splice(from, 1);
        this.windows.splice(index, 0, window);
        this._onChanged();
    }

    // Pull a tab out and keep dragging it as a free window. Removing it may
    // dissolve this group, so nothing here touches the group afterwards.
    _detach(window, event) {
        const [x, y] = event.get_coords();
        const rect = window.get_frame_rect();
        this.remove(window, {refocus: false});
        window.move_frame(true,
            Math.round(x - Math.min(rect.width / 2, DETACH_GRAB_X)),
            Math.round(y - DETACH_GRAB_Y));
        dragWindow(window, event);
    }

    _onGeometryChanged(window) {
        if (window !== this.active)
            return;

        this._syncBar();
        // Hidden tabs wait at the last normal rectangle while the active
        // one is fullscreen or (briefly) maximized.
        if (window.is_fullscreen())
            return;
        if (!window.is_maximized()) {
            this._rect = copyRect(window.get_frame_rect());
            for (const other of this.windows) {
                if (other !== window)
                    place(other, this._rect);
            }
        }
        this.queueSettle();
    }

    // Minimizing the visible tab minimizes the group; bringing any tab back
    // brings the group back.
    _onMinimizedChanged(window) {
        if (this._syncingState)
            return;
        const minimized = window.minimized;
        if (minimized && window !== this.active)
            return;

        this._syncingState = true;
        for (const other of this.windows) {
            if (other === window || other.minimized === minimized)
                continue;
            if (minimized)
                other.minimize();
            else
                other.unminimize();
        }
        this._syncingState = false;
        if (!minimized)
            this.queueSettle();
    }

    // Moving any tab to another workspace moves the group. Windows that are
    // on all workspaces (for example on a secondary monitor) need nothing.
    _onWorkspaceChanged(window) {
        if (this._syncingState || window.is_on_all_workspaces())
            return;
        const workspace = window.get_workspace();
        if (!workspace)
            return;

        this._syncingState = true;
        for (const other of this.windows) {
            if (other !== window && !other.is_on_all_workspaces() &&
                other.get_workspace() !== workspace)
                other.change_workspace(workspace);
        }
        this._syncingState = false;
    }

    _syncBar() {
        const window = this.active;
        if (!window || !this._bar)
            return;

        // The actor's origin is the buffer rectangle, which includes
        // shadows; the bar is aligned to the visible frame.
        const frame = window.get_frame_rect();
        const buffer = window.get_buffer_rect();
        this._bar.set_position(frame.x - buffer.x, frame.y - buffer.y - this._barHeight);
        this._bar.set_size(frame.width, this._barHeight);
        // No room above a fullscreen window, or a maximized one in the
        // moment before it is turned into a filled group.
        this._bar.visible = !window.is_maximized() && !window.is_fullscreen();
    }
}
