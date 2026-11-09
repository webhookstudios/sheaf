import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

const SHORTCUTS = [
    ['group-windows', 'Group with previous window',
        'Puts the focused window into the same slot as the window used before it'],
    ['ungroup-window', 'Ungroup window', 'Takes the focused window out of its group'],
    ['next-tab', 'Next tab', ''],
    ['previous-tab', 'Previous tab', ''],
];

const COLORS = [
    ['bar-color', 'Tab bar'],
    ['active-tab-color', 'Selected tab'],
    ['text-color', 'Text and icons'],
];

function switchRow(settings, key, title, subtitle) {
    const row = new Adw.SwitchRow({title, subtitle});
    settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
    return row;
}

function spinRow(settings, key, title, subtitle, step) {
    // The allowed range comes from the schema, so it is defined once.
    const [, [lower, upper]] = settings.settings_schema.get_key(key)
        .get_range().recursiveUnpack();
    const row = new Adw.SpinRow({
        title,
        subtitle,
        adjustment: new Gtk.Adjustment({
            lower,
            upper,
            step_increment: step,
            page_increment: step * 5,
        }),
    });
    settings.bind(key, row, 'value', Gio.SettingsBindFlags.DEFAULT);
    return row;
}

function toHex(rgba) {
    const part = value => Math.round(value * 255).toString(16).padStart(2, '0');
    return `#${part(rgba.red)}${part(rgba.green)}${part(rgba.blue)}`;
}

function colorRow(settings, key, title) {
    const button = new Gtk.ColorDialogButton({
        dialog: new Gtk.ColorDialog({with_alpha: false}),
        valign: Gtk.Align.CENTER,
    });
    const show = () => {
        const rgba = new Gdk.RGBA();
        if (rgba.parse(settings.get_string(key)) && toHex(rgba) !== toHex(button.rgba))
            button.rgba = rgba;
    };
    show();
    settings.connect(`changed::${key}`, show);
    button.connect('notify::rgba', () => {
        const hex = toHex(button.rgba);
        if (hex !== settings.get_string(key))
            settings.set_string(key, hex);
    });

    const row = new Adw.ActionRow({title, activatable_widget: button});
    row.add_suffix(button);
    return row;
}

function shortcutText(settings, key) {
    const [accelerator] = settings.get_strv(key);
    if (!accelerator)
        return 'Disabled';
    const [ok, keyval, mods] = Gtk.accelerator_parse(accelerator);
    return ok ? Gtk.accelerator_get_label(keyval, mods) : accelerator;
}

// Opens a small dialog that waits for a key combination and stores it.
function captureShortcut(parent, settings, key, title) {
    const dialog = new Adw.Window({
        modal: true,
        transient_for: parent,
        title,
        default_width: 380,
        default_height: 180,
    });
    const view = new Adw.ToolbarView();
    view.add_top_bar(new Adw.HeaderBar());
    view.set_content(new Adw.StatusPage({
        title: 'Press the new shortcut',
        description: 'Esc cancels. Backspace disables the shortcut.\nShortcuts already used by the desktop cannot be chosen.',
    }));
    dialog.set_content(view);

    const controller = new Gtk.EventControllerKey();
    controller.connect('key-pressed', (_controller, keyval, keycode, state) => {
        const mods = state & Gtk.accelerator_get_default_mod_mask();
        if (mods === 0 && keyval === Gdk.KEY_Escape) {
            dialog.close();
        } else if (mods === 0 && keyval === Gdk.KEY_BackSpace) {
            settings.set_strv(key, []);
            dialog.close();
        } else if (mods !== 0 && Gtk.accelerator_valid(keyval, mods)) {
            settings.set_strv(key, [Gtk.accelerator_name_with_keycode(
                null, Gdk.keyval_to_lower(keyval), keycode, mods)]);
            dialog.close();
        }
        return Gdk.EVENT_STOP;
    });
    dialog.add_controller(controller);
    // Combinations the desktop already uses never reach this dialog.
    // Asking the shell to hand them over would put a permission prompt in
    // front of every change, so they are simply not available here.
    dialog.present();
}

function shortcutRow(window, settings, key, title, subtitle) {
    const label = new Gtk.Label({
        label: shortcutText(settings, key),
        css_classes: ['dim-label'],
        valign: Gtk.Align.CENTER,
    });
    settings.connect(`changed::${key}`, () => (label.label = shortcutText(settings, key)));

    const row = new Adw.ActionRow({title, subtitle, activatable: true});
    row.add_suffix(label);
    row.add_suffix(new Gtk.Image({icon_name: 'go-next-symbolic'}));
    row.connect('activated', () => captureShortcut(window, settings, key, title));
    return row;
}

export default class SheafPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        const page = new Adw.PreferencesPage();
        window.add(page);

        const grouping = new Adw.PreferencesGroup({title: 'Grouping'});
        grouping.add(spinRow(settings, 'hover-group-delay', 'Hold time',
            'Milliseconds to hold a dragged window over another before releasing groups them', 50));
        grouping.add(switchRow(settings, 'auto-group-same-app',
            'Group windows of the same app',
            'A new window joins the other windows of its application on the same workspace'));
        grouping.add(switchRow(settings, 'tabs-on-all-windows',
            'Tab bar on every window',
            'Windows that are not in a group get a bar with a single tab'));
        grouping.add(switchRow(settings, 'restore-groups',
            'Restore groups',
            'After logging in again, windows go back into their groups, matched by application and title'));
        page.add(grouping);

        const reset = new Gtk.Button({
            label: 'Reset',
            valign: Gtk.Align.CENTER,
            css_classes: ['flat'],
        });
        reset.connect('clicked', () => {
            settings.reset('bar-height');
            COLORS.forEach(([key]) => settings.reset(key));
        });
        const appearance = new Adw.PreferencesGroup({title: 'Appearance', header_suffix: reset});
        appearance.add(spinRow(settings, 'bar-height', 'Tab bar height', 'Pixels', 1));
        for (const [key, title] of COLORS)
            appearance.add(colorRow(settings, key, title));
        page.add(appearance);

        const shortcuts = new Adw.PreferencesGroup({title: 'Keyboard shortcuts'});
        for (const [key, title, subtitle] of SHORTCUTS)
            shortcuts.add(shortcutRow(window, settings, key, title, subtitle));
        page.add(shortcuts);
    }
}
