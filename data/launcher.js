#!/usr/bin/gjs -m
// What the "Sheaf" entry in the apps menu runs. Sheaf itself is a GNOME
// Shell extension with no window of its own, so this turns the extension on
// if needed and opens its preferences. Right after installing, the running
// shell does not know the extension yet; then it says so instead.

import Adw from 'gi://Adw?version=1';
import Gio from 'gi://Gio';
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
