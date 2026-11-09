import Pango from 'gi://Pango';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

// The menu behind a tab bar's "+" button. It lists every window that could
// be added to the group, and above those, one entry per application that
// has several such windows, to add them all at once.
//
// `getAddable()` returns the candidate windows; `onAdd(windows)` adds them.
export class AddMenu {
    constructor(sourceActor, {getAddable, onAdd}) {
        this._getAddable = getAddable;
        this._onAdd = onAdd;

        this._menu = new PopupMenu.PopupMenu(sourceActor, 0.5, St.Side.TOP);
        this._menu.actor.add_style_class_name('sheaf-add-menu');
        this._menu.actor.hide();
        Main.uiGroup.add_child(this._menu.actor);
        // Closes the menu on a click elsewhere or Escape.
        this._manager = new PopupMenu.PopupMenuManager(sourceActor);
        this._manager.addMenu(this._menu);
    }

    toggle() {
        if (this._menu.isOpen) {
            this._menu.close();
            return;
        }
        this._populate();
        this._menu.open();
    }

    destroy() {
        this._menu.destroy();
    }

    // Rebuilt on every open, since windows come and go.
    _populate() {
        this._menu.removeAll();

        const windows = this._getAddable();
        if (windows.length === 0) {
            this._menu.addMenuItem(new PopupMenu.PopupMenuItem(
                'No other windows to add', {reactive: false}));
            return;
        }

        const tracker = Shell.WindowTracker.get_default();
        const byApp = new Map();
        for (const window of windows) {
            const app = tracker.get_window_app(window);
            if (!byApp.has(app))
                byApp.set(app, []);
            byApp.get(app).push(window);
        }

        let hasAppEntries = false;
        for (const [app, appWindows] of byApp) {
            if (!app || appWindows.length < 2)
                continue;
            this._addItem(`All ${app.get_name()} windows (${appWindows.length})`,
                app, appWindows);
            hasAppEntries = true;
        }
        if (hasAppEntries)
            this._menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        for (const window of windows) {
            const app = tracker.get_window_app(window);
            this._addItem(window.title || app?.get_name() || 'Untitled window',
                app, [window]);
        }
    }

    _addItem(text, app, windows) {
        const icon = app?.get_icon();
        const item = icon
            ? new PopupMenu.PopupImageMenuItem(text, icon)
            : new PopupMenu.PopupMenuItem(text);
        item.label.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        item.connect('activate', () => this._onAdd(windows));
        this._menu.addMenuItem(item);
    }
}
