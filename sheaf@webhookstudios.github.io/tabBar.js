import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import Shell from 'gi://Shell';
import St from 'gi://St';

import {AddMenu} from './addMenu.js';

const ICON_SIZE = 16;
// Tab width while there is room; tabs shrink evenly once the bar is full.
const TAB_WIDTH = 200;
// Pointer travel before a press counts as a drag instead of a click.
const DRAG_THRESHOLD = 8;
// How far above or below the bar a dragged tab must go to be pulled out.
const DETACH_MARGIN = 14;
// Title and icon opacity of tabs that are not selected.
const INACTIVE_OPACITY = 170;

// The strip of tabs drawn above a group. It only displays and interprets
// pointer gestures; the group decides what each one does through `handlers`:
//
//   onActivate(window)        tab clicked
//   onClose(window)           close button, or middle click on a tab
//   onReorder(window, index)  tab dragged sideways to a new position
//   onDetach(window, event)   tab dragged out of the bar
//   onMove(event)             grip or empty bar area dragged
//   getAddable()              windows the "+" menu should offer
//   onAdd(windows)            entry picked in the "+" menu
//
// `colors` is {bar, activeTab, text}, each a CSS color.
export const TabBar = GObject.registerClass(
class TabBar extends St.BoxLayout {
    _init(handlers, colors) {
        super._init({style_class: 'sheaf-bar', reactive: true});
        this._handlers = handlers;
        this._tabs = new Map();
        this._activeWindow = null;
        this._press = null;

        // Not reactive, so a press on it lands on the bar itself.
        this.add_child(new St.Icon({
            style_class: 'sheaf-grip',
            icon_name: 'list-drag-handle-symbolic',
            icon_size: ICON_SIZE,
            opacity: INACTIVE_OPACITY,
            y_align: Clutter.ActorAlign.CENTER,
        }));

        // Explicitly not expanding: tabs keep their natural width and the
        // rest of the bar stays empty, which is the area that drags the group.
        this._tabBox = new St.BoxLayout({style_class: 'sheaf-tabs', x_expand: false});
        this._tabBox.layout_manager.homogeneous = true;
        this._tabWidth = TAB_WIDTH *
            St.ThemeContext.get_for_stage(global.stage).scale_factor;
        this.add_child(this._tabBox);

        // Sits right after the last tab.
        const addButton = new St.Button({
            style_class: 'sheaf-add',
            icon_name: 'list-add-symbolic',
            accessible_name: 'Add windows to this group',
            y_align: Clutter.ActorAlign.CENTER,
        });
        addButton.connect('clicked', () => {
            this._addMenu ??= new AddMenu(addButton, {
                getAddable: handlers.getAddable,
                onAdd: handlers.onAdd,
            });
            this._addMenu.toggle();
        });
        this.add_child(addButton);

        this.connect('button-press-event', (_actor, event) => this._onPress(null, event));
        this.connect('captured-event', (_actor, event) => this._onCaptured(event));
        this.connect('destroy', () => {
            this._endPress();
            this._addMenu?.destroy();
            this._addMenu = null;
        });

        this.setColors(colors);
    }

    setColors(colors) {
        this._colors = colors;
        // Icons and labels inherit the text color from the bar.
        this.style = `color: ${colors.text};`;
        this._styleTabs();
    }

    addTab(window) {
        const app = Shell.WindowTracker.get_default().get_window_app(window);
        const icon = app?.create_icon_texture(ICON_SIZE) ?? new St.Icon({
            icon_name: 'application-x-executable-symbolic',
            icon_size: ICON_SIZE,
        });
        icon.y_align = Clutter.ActorAlign.CENTER;

        const label = new St.Label({
            text: window.title ?? '',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        label.clutter_text.ellipsize = Pango.EllipsizeMode.END;

        const close = new St.Button({
            style_class: 'sheaf-close',
            icon_name: 'window-close-symbolic',
            y_align: Clutter.ActorAlign.CENTER,
        });
        close.connect('clicked', () => this._handlers.onClose(window));

        const tab = new St.BoxLayout({
            style_class: 'sheaf-tab',
            reactive: true,
            track_hover: true,
            x_expand: true,
            natural_width: this._tabWidth,
        });
        tab.add_child(icon);
        tab.add_child(label);
        tab.add_child(close);
        tab.connect('button-press-event', (_actor, event) => this._onPress(window, event));
        window.connectObject('notify::title',
            () => (label.text = window.title ?? ''), tab);

        this._tabBox.add_child(tab);
        this._tabs.set(window, tab);
        this._styleTabs();
    }

    removeTab(window) {
        if (this._press?.window === window)
            this._endPress();
        this._tabs.get(window)?.destroy();
        this._tabs.delete(window);
    }

    setActiveTab(window) {
        this._activeWindow = window;
        this._styleTabs();
    }

    _styleTabs() {
        for (const [window, tab] of this._tabs) {
            const active = window === this._activeWindow;
            tab.style = active ? `background-color: ${this._colors.activeTab};` : null;
            // Icon and title; the close button stays fully visible.
            tab.get_child_at_index(0).opacity = active ? 255 : INACTIVE_OPACITY;
            tab.get_child_at_index(1).opacity = active ? 255 : INACTIVE_OPACITY;
        }
    }

    // `window` is the pressed tab's window, or null for the grip and the
    // empty part of the bar. The grab keeps motion and release coming here
    // even when the pointer leaves the bar.
    _onPress(window, event) {
        const button = event.get_button();
        const usable = button === Clutter.BUTTON_PRIMARY ||
            (window && button === Clutter.BUTTON_MIDDLE);
        if (this._press || !usable)
            return Clutter.EVENT_PROPAGATE;

        // A press on a close button also reaches the tab and the bar.
        // Grabbing here would cancel the button's own click.
        for (let actor = global.stage.get_event_actor(event);
            actor && actor !== this; actor = actor.get_parent()) {
            if (actor instanceof St.Button)
                return Clutter.EVENT_PROPAGATE;
        }

        const [x, y] = event.get_coords();
        this._press = {window, button, x, y, dragging: false, grab: global.stage.grab(this)};
        return Clutter.EVENT_STOP;
    }

    _endPress() {
        this._press?.grab.dismiss();
        this._press = null;
    }

    _onCaptured(event) {
        if (!this._press)
            return Clutter.EVENT_PROPAGATE;

        switch (event.type()) {
        case Clutter.EventType.MOTION:
            if (this._press.button === Clutter.BUTTON_PRIMARY)
                this._onDragMotion(event);
            return Clutter.EVENT_STOP;
        case Clutter.EventType.BUTTON_RELEASE: {
            if (event.get_button() !== this._press.button)
                return Clutter.EVENT_STOP;
            const {window, button, dragging} = this._press;
            this._endPress();
            if (window && !dragging) {
                if (button === Clutter.BUTTON_MIDDLE)
                    this._handlers.onClose(window);
                else
                    this._handlers.onActivate(window);
            }
            return Clutter.EVENT_STOP;
        }
        default:
            return Clutter.EVENT_PROPAGATE;
        }
    }

    _onDragMotion(event) {
        const press = this._press;
        const [x, y] = event.get_coords();
        if (!press.dragging && Math.hypot(x - press.x, y - press.y) < DRAG_THRESHOLD)
            return;
        press.dragging = true;

        // The handlers below may destroy this bar, so the press is always
        // ended before calling them.
        if (!press.window) {
            this._endPress();
            this._handlers.onMove(event);
            return;
        }

        const [, barY] = this.get_transformed_position();
        const [, barHeight] = this.get_transformed_size();
        if (y < barY - DETACH_MARGIN || y > barY + barHeight + DETACH_MARGIN) {
            this._endPress();
            this._handlers.onDetach(press.window, event);
            return;
        }

        // Tabs are equal width, so the slot under the pointer is the index.
        const [boxX] = this._tabBox.get_transformed_position();
        const [boxWidth] = this._tabBox.get_transformed_size();
        const count = this._tabs.size;
        const slot = Math.floor((x - boxX) / (boxWidth / count));
        const index = Math.max(0, Math.min(count - 1, slot));
        const tab = this._tabs.get(press.window);
        if (this._tabBox.get_children().indexOf(tab) !== index) {
            this._tabBox.set_child_at_index(tab, index);
            this._handlers.onReorder(press.window, index);
        }
    }
});
