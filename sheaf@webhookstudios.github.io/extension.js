import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {Group} from './group.js';
import {HoverJoin} from './hoverJoin.js';

const UNGROUP_OFFSET = 40;
// Group changes are written to settings this long after the last one. Apps
// closing at logout shrink every group; the shell is gone before the delay
// runs out, so the groups as they were are what gets restored.
const SAVE_DELAY_SECONDS = 5;
// Saved groups are matched against windows that open within this long of
// the extension starting. After that a new window is just a new window.
const RESTORE_WINDOW_SECONDS = 300;

function isGroupable(window) {
    return window &&
        window.get_window_type() === Meta.WindowType.NORMAL &&
        !window.is_skip_taskbar();
}

function isMoveDrag(grabOp) {
    return grabOp === Meta.GrabOp.MOVING ||
        grabOp === Meta.GrabOp.MOVING_UNCONSTRAINED;
}

function isOpen(window) {
    return window.get_compositor_private() !== null;
}

// What identifies a window across sessions: its application and title.
// Windows without a desktop file fall back to their window class.
function describe(window) {
    const app = Shell.WindowTracker.get_default().get_window_app(window);
    const appId = !app || app.is_window_backed()
        ? `class:${window.get_wm_class() ?? ''}`
        : app.get_id();
    return {app: appId, title: window.title ?? ''};
}

export default class SheafExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._groups = new Set();
        this._grabbedWindow = null;
        this._saveId = 0;
        this._soloSyncId = 0;
        this._hoverJoin = new HoverJoin({
            getDelay: () => this._settings.get_int('hover-group-delay'),
            pickTarget: (window, x, y) => this._pickJoinTarget(window, x, y),
        });

        this._shortcuts = {
            'group-windows': () => this._groupFocused(),
            'ungroup-window': () => this._ungroupFocused(),
            'next-tab': () => this._cycle(1),
            'previous-tab': () => this._cycle(-1),
        };
        for (const [name, handler] of Object.entries(this._shortcuts)) {
            Main.wm.addKeybinding(name, this._settings,
                Meta.KeyBindingFlags.IGNORE_AUTOREPEAT,
                Shell.ActionMode.NORMAL, handler);
        }

        global.display.connectObject(
            'notify::focus-window', () => this._onFocusChanged(),
            'grab-op-begin', (_display, window, grabOp) => {
                this._grabbedWindow = window;
                const group = this._groupOf(window);
                if (group?.active === window)
                    group.dragging = true;
                if (isMoveDrag(grabOp) && isGroupable(window))
                    this._hoverJoin.begin(window);
            },
            'grab-op-end', (_display, window) => this._onDragEnded(window),
            this);
        global.window_manager.connectObject(
            'map', (_wm, actor) => this._onWindowOpened(actor.meta_window), this);

        const restyle = () => {
            const appearance = this._appearance();
            for (const group of this._groups)
                group.setAppearance(appearance);
        };
        this._settings.connectObject(
            'changed::bar-height', restyle,
            'changed::bar-color', restyle,
            'changed::active-tab-color', restyle,
            'changed::text-color', restyle,
            'changed::tabs-on-all-windows', () => this._syncSoloTabs(),
            'changed::restore-groups', () => this._queueSave(),
            this);

        this._loadSavedGroups();
        for (const window of this._openWindows().reverse())
            this._restoreInto(window);
        this._syncSoloTabs();
    }

    disable() {
        // Dissolving the groups below must not overwrite what was saved.
        this._saving = false;
        for (const id of [this._saveId, this._soloSyncId]) {
            if (id)
                GLib.source_remove(id);
        }
        this._saveId = 0;
        this._soloSyncId = 0;

        global.display.disconnectObject(this);
        global.window_manager.disconnectObject(this);
        this._settings.disconnectObject(this);
        for (const name of Object.keys(this._shortcuts))
            Main.wm.removeKeybinding(name);
        this._hoverJoin.end();
        for (const group of [...this._groups])
            group.destroy();

        this._hoverJoin = null;
        this._shortcuts = null;
        this._groups = null;
        this._pending = null;
        this._grabbedWindow = null;
        this._settings = null;
    }

    // ---- Groups ----------------------------------------------------------

    _groupOf(window) {
        if (!window)
            return null;
        for (const group of this._groups) {
            if (group.has(window))
                return group;
        }
        return null;
    }

    // In a group with other windows. With "tab bar on every window" on, a
    // window alone under its own bar is in a group of one, which does not
    // count.
    _isTabbed(window) {
        return (this._groupOf(window)?.windows.length ?? 0) > 1;
    }

    get _soloTabs() {
        return this._settings.get_boolean('tabs-on-all-windows');
    }

    _appearance() {
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        return {
            barHeight: this._settings.get_int('bar-height') * scale,
            colors: {
                bar: this._settings.get_string('bar-color'),
                activeTab: this._settings.get_string('active-tab-color'),
                text: this._settings.get_string('text-color'),
            },
        };
    }

    _createGroup() {
        const group = new Group({
            ...this._appearance(),
            minSize: this._soloTabs ? 1 : 2,
            getAddable: asking => this._openWindows()
                .filter(w => !this._isTabbed(w) && !asking.has(w)),
            addWindows: (target, windows) => {
                for (const window of windows) {
                    if (target.has(window))
                        continue;
                    this._takeOut(window);
                    target.add(window);
                }
            },
            onChanged: () => this._queueSave(),
            onReleased: () => this._queueSoloSync(),
            onDissolved: dissolved => {
                this._groups?.delete(dissolved);
                this._queueSoloSync();
            },
        });
        this._groups.add(group);
        return group;
    }

    // Every open window that could be in a group, on any workspace, most
    // recently used first.
    _openWindows() {
        return global.display.get_tab_list(Meta.TabList.NORMAL, null)
            .filter(isGroupable);
    }

    // Frees `window` from whatever group it is in, so it can join another.
    _takeOut(window) {
        const group = this._groupOf(window);
        if (!group)
            return;
        if (group.windows.length > 1)
            group.remove(window, {refocus: false});
        else
            group.destroy();
    }

    // Puts free `windows` into `target`'s slot, creating a group around
    // `target` if it has none, and shows `active`.
    _join(windows, target, active) {
        let group = this._groupOf(target);
        if (!group) {
            group = this._createGroup();
            group.add(target);
        }
        for (const window of windows)
            group.add(window);
        group.setActive(active);
        group.queueSettle();
        return group;
    }

    // ---- Shortcuts -------------------------------------------------------

    // Puts the focused window into the same slot as the window that had
    // focus before it. The focused window ends up as the visible tab.
    _groupFocused() {
        const focused = global.display.focus_window;
        if (!isGroupable(focused))
            return;

        const own = this._groupOf(focused);
        const workspace = global.workspace_manager.get_active_workspace();
        // Most recently used first, so this is the previously focused window
        // that is not already a tab alongside the focused one.
        const target = global.display.get_tab_list(Meta.TabList.NORMAL, workspace)
            .find(w => w !== focused && isGroupable(w) && !own?.has(w));
        if (!target)
            return;

        if (this._isTabbed(focused) && !this._isTabbed(target)) {
            // The focused window already has tabs: pull the other one in.
            this._takeOut(target);
            own.add(target);
            return;
        }

        this._takeOut(focused);
        this._join([focused], target, focused);
    }

    _ungroupFocused() {
        const focused = global.display.focus_window;
        if (!this._isTabbed(focused))
            return;

        this._groupOf(focused).remove(focused, {refocus: false});
        // Offset it so the group underneath is visibly a separate thing.
        const rect = focused.get_frame_rect();
        focused.move_frame(true, rect.x + UNGROUP_OFFSET, rect.y + UNGROUP_OFFSET);
    }

    _cycle(step) {
        const focused = global.display.focus_window;
        const group = this._groupOf(focused);
        if (!group)
            return;

        const count = group.windows.length;
        const index = group.windows.indexOf(focused);
        group.activate(group.windows[(index + step + count) % count]);
    }

    // ---- Following the desktop --------------------------------------------

    // Alt-Tab, the dock or an app raising itself can focus a hidden tab.
    // Treat that as switching to it.
    _onFocusChanged() {
        const focused = global.display.focus_window;
        this._groupOf(focused)?.setActive(focused);
    }

    _onDragEnded(window) {
        const target = this._hoverJoin.end();
        this._grabbedWindow = null;
        for (const group of this._groups)
            group.dragging = false;

        if (target && window) {
            // Dragging a group onto something brings all its tabs along.
            const own = this._groupOf(window);
            const moving = own ? [...own.windows] : [window];
            own?.destroy();
            this._join(moving, target, window);
            return;
        }

        // Dropped against the top edge or tiled: make room for the bar.
        this._groupOf(window)?.queueSettle();
    }

    // A new window is, in order of preference: put back into the group it
    // was saved in, grouped with its application's other windows, or given
    // a tab bar of its own. The last two only if their setting is on.
    _onWindowOpened(window) {
        if (!isGroupable(window) || this._groupOf(window))
            return;
        if (this._restoreInto(window))
            return;

        if (this._settings.get_boolean('auto-group-same-app')) {
            const tracker = Shell.WindowTracker.get_default();
            const app = tracker.get_window_app(window);
            const sibling = global.display
                .get_tab_list(Meta.TabList.NORMAL, window.get_workspace())
                .find(w => w !== window && isGroupable(w) &&
                    tracker.get_window_app(w) === app);
            if (sibling) {
                this._join([window], sibling, window);
                return;
            }
        }

        this._wrapSolo(window);
    }

    // What a window dragged to (x, y) would join: the topmost window there,
    // counting a group's tab bar as part of it. Maximized and fullscreen
    // windows are not offered, since nearly every drag passes over one.
    _pickJoinTarget(dragged, x, y) {
        const draggedGroup = this._groupOf(dragged);
        const workspace = global.workspace_manager.get_active_workspace();
        const topFirst = global.display
            .sort_windows_by_stacking(workspace.list_windows()).reverse();

        for (const window of topFirst) {
            if (window === dragged || draggedGroup?.has(window))
                continue;
            if (!window.showing_on_its_workspace())
                continue;
            const group = this._groupOf(window);
            if (group && group.active !== window)
                continue;

            const rect = window.get_frame_rect();
            const barHeight = group?.barHeight ?? 0;
            const inColumn = x >= rect.x && x < rect.x + rect.width;
            const onBar = inColumn && y >= rect.y - barHeight && y < rect.y;
            const onWindow = inColumn && y >= rect.y && y < rect.y + rect.height;
            if (!onBar && !onWindow)
                continue;

            if (!isGroupable(window) || window.is_maximized() || window.is_fullscreen())
                return null;
            return {
                target: window,
                // A lone window's own bar is not a drop target that skips
                // the hold: only bars of real groups are.
                onBar: onBar && this._isTabbed(window),
                rect: {
                    x: rect.x,
                    y: rect.y - barHeight,
                    width: rect.width,
                    height: rect.height + barHeight,
                },
            };
        }
        return null;
    }

    // ---- Tab bar on every window -----------------------------------------

    _wrapSolo(window) {
        if (!this._soloTabs || !isGroupable(window) || !isOpen(window) ||
            this._groupOf(window))
            return;

        const group = this._createGroup();
        group.dragging = window === this._grabbedWindow;
        group.add(window);
        group.queueSettle();
    }

    // Brings the groups in line with the setting: a bar for every lone
    // window when it is on, none when it is off.
    _syncSoloTabs() {
        const solo = this._soloTabs;
        for (const group of [...this._groups]) {
            group.minSize = solo ? 1 : 2;
            if (group.windows.length < group.minSize)
                group.destroy();
        }
        if (solo)
            this._openWindows().forEach(window => this._wrapSolo(window));
    }

    // Windows are often freed just to be put somewhere else in the same
    // breath, so lone windows are picked up afterwards.
    _queueSoloSync() {
        if (this._soloSyncId || !this._groups || !this._soloTabs)
            return;
        this._soloSyncId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._soloSyncId = 0;
            this._syncSoloTabs();
            return GLib.SOURCE_REMOVE;
        });
    }

    // ---- Saving and restoring groups ---------------------------------------

    _queueSave() {
        if (!this._saving)
            return;
        if (this._saveId)
            GLib.source_remove(this._saveId);
        this._saveId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT,
            SAVE_DELAY_SECONDS, () => {
                this._saveId = 0;
                this._save();
                return GLib.SOURCE_REMOVE;
            });
    }

    _save() {
        const groups = this._settings.get_boolean('restore-groups')
            ? [...this._groups]
                .filter(group => group.windows.length > 1)
                .map(group => group.windows.map(describe))
            : [];
        this._settings.set_string('saved-groups', JSON.stringify(groups));
    }

    _loadSavedGroups() {
        this._pending = [];
        this._pendingUntil = GLib.get_monotonic_time() + RESTORE_WINDOW_SECONDS * 1e6;
        if (this._settings.get_boolean('restore-groups')) {
            try {
                const saved = JSON.parse(this._settings.get_string('saved-groups'));
                this._pending = saved.map(members =>
                    members.map(({app, title}) => ({app, title, window: null})));
            } catch (e) {
                console.warn(`Sheaf: ignoring unreadable saved groups: ${e.message}`);
            }
        }
        this._saving = true;
    }

    // If `window` matches a member of a saved group, claims that place for
    // it, and once two members of the group are open puts them together.
    // Returns whether the window ended up in a group.
    _restoreInto(window) {
        if (!this._pending.length || this._isTabbed(window) ||
            GLib.get_monotonic_time() > this._pendingUntil)
            return false;

        const {app, title} = describe(window);
        const free = this._pending.flatMap(members =>
            members.filter(m => !m.window && m.app === app).map(m => ({m, members})));
        // The same title is a sure match; failing that, the same app.
        const match = free.find(({m}) => m.title === title) ?? free[0];
        if (!match)
            return false;
        match.m.window = window;

        const partner = match.members
            .map(m => m.window)
            .find(w => w && w !== window && isOpen(w));
        if (!partner)
            return false;

        this._takeOut(window);
        const group = this._groupOf(partner);
        this._join([window], partner, group?.active ?? partner);
        return true;
    }
}
