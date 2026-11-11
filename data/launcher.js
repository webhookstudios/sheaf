#!/usr/bin/gjs -m
// What the "Sheaf" entry in the apps menu runs. Sheaf itself is a GNOME
// Shell extension with no window of its own, so this turns the extension on
// if needed and opens its preferences. Right after installing, the running
// shell does not know the extension yet; then it says so instead.

import Adw from 'gi://Adw?version=1';
import Gio from 'gi://Gio';
import PangoCairo from 'gi://PangoCairo';
import Gdk from 'gi://Gdk?version=4.0';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';

const UUID = 'sheaf@webhookstudios.github.io';
const APP_ID = 'io.github.webhookstudios.Sheaf';

function run(...argv) {
    try {
        const process = Gio.Subprocess.new(argv,
            Gio.SubprocessFlags.STDOUT_SILENCE | Gio.SubprocessFlags.STDERR_SILENCE);
        process.wait(null);
        return process.get_successful();
    } catch {
        return false;
    }
}

// Adds Sheaf to the shell's list of enabled extensions. Unlike
// `gnome-extensions enable`, this also works before the shell has seen the
// extension, so it comes on by itself at the next login.
function markEnabled() {
    const settings = new Gio.Settings({schema_id: 'org.gnome.shell'});
    const enabled = settings.get_strv('enabled-extensions');
    if (!enabled.includes(UUID))
        settings.set_strv('enabled-extensions', [...enabled, UUID]);
    const disabled = settings.get_strv('disabled-extensions');
    if (disabled.includes(UUID))
        settings.set_strv('disabled-extensions', disabled.filter(id => id !== UUID));
    Gio.Settings.sync();
}

// The Sedge look for this window. The kit ships inside the installed extension.
function styleWindow(window) {
    const dir = [GLib.get_user_data_dir(), ...GLib.get_system_data_dirs()]
        .map(base => GLib.build_filenamev([base, 'gnome-shell', 'extensions', UUID, 'sedge']))
        .find(d => GLib.file_test(`${d}/sedge-scoped.css`, GLib.FileTest.EXISTS));
    if (!dir)
        return;
    const fontmap = PangoCairo.FontMap.get_default();
    for (const font of ['YoungSerif-Regular.ttf', 'PublicSans[wght].ttf'])
        try {
            fontmap.add_font_file?.(`${dir}/fonts/${font}`);
        } catch {
            // The system font is fine.
        }
    const sheet = name => {
        const provider = new Gtk.CssProvider();
        provider.load_from_path(`${dir}/${name}`);
        return provider;
    };
    const display = Gdk.Display.get_default();
    const priority = Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION - 1;
    Gtk.StyleContext.add_provider_for_display(display, sheet('sedge-scoped.css'), priority);
    const dark = sheet('sedge-scoped-dark.css');
    const manager = Adw.StyleManager.get_default();
    const follow = () => {
        if (manager.get_dark())
            Gtk.StyleContext.add_provider_for_display(display, dark, priority);
        else
            Gtk.StyleContext.remove_provider_for_display(display, dark);
    };
    manager.connect('notify::dark', follow);
    follow();
    window.add_css_class('sedge');
}

function showLogoutNotice(app) {
    const page = new Adw.StatusPage({
        icon_name: APP_ID,
        title: 'Log out to finish',
        description: 'Sheaf is installed and will turn on the next time you log in.\n' +
            'Log out and back in, then open Sheaf again for its settings.',
        vexpand: true,
    });
    const close = new Gtk.Button({
        label: 'Close',
        halign: Gtk.Align.CENTER,
        css_classes: ['pill', 'suggested-action'],
    });
    page.set_child(close);

    const view = new Adw.ToolbarView({content: page});
    view.add_top_bar(new Adw.HeaderBar());
    const window = new Adw.ApplicationWindow({
        application: app,
        title: 'Sheaf',
        default_width: 460,
        default_height: 470,
        content: view,
    });
    close.connect('clicked', () => window.close());
    styleWindow(window);
    window.present();
}

const app = new Adw.Application({application_id: APP_ID});
app.connect('activate', () => {
    markEnabled();
    // `info` fails while the running shell has not loaded the extension.
    if (run('gnome-extensions', 'info', UUID))
        run('gnome-extensions', 'prefs', UUID);
    else
        showLogoutNotice(app);
});
app.run([]);
