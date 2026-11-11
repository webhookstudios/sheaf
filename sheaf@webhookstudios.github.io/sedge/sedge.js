// Sedge design kit for GTK 4 apps and GNOME extension preferences written in GJS.
//
// Apps:        applyToApp(dir)            styles the whole app.
// Extensions:  applyToWindow(window, dir) styles one preferences window only,
//              because every extension's preferences run in the same process.
// `dir` is the folder holding this file, sedge.css or sedge-scoped.css, and fonts/.
//
// This file is copied in by sedge-design/sync.py. Change the kit there.
import Adw from 'gi://Adw?version=1';
import Gdk from 'gi://Gdk?version=4.0';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';
import PangoCairo from 'gi://PangoCairo';

const FONTS = ['YoungSerif-Regular.ttf', 'PublicSans[wght].ttf', 'PublicSans-Italic[wght].ttf'];
const loaded = new Set();

function addFonts(dir) {
    const fontmap = PangoCairo.FontMap.get_default();
    if (typeof fontmap.add_font_file !== 'function')
        return; // Pango older than 1.56: the system fonts are used instead.
    for (const name of FONTS) {
        const path = GLib.build_filenamev([dir, 'fonts', name]);
        if (!GLib.file_test(path, GLib.FileTest.EXISTS))
            continue;
        try {
            fontmap.add_font_file(path);
        } catch (e) {
            // A missing or broken font must never stop the app.
        }
    }
}

function sheet(dir, file) {
    const provider = new Gtk.CssProvider();
    provider.load_from_file(Gio.File.new_for_path(GLib.build_filenamev([dir, file])));
    return provider;
}

// Adds the dark colors while libadwaita's style manager says the app is dark.
// Synchronous on purpose: no promises, so it works however the app runs its main loop.
function followDark(display, provider) {
    const priority = Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION - 1;
    let on = false;
    const setDark = dark => {
        if (dark === on)
            return;
        on = dark;
        if (dark)
            Gtk.StyleContext.add_provider_for_display(display, provider, priority);
        else
            Gtk.StyleContext.remove_provider_for_display(display, provider);
    };
    const manager = Adw.StyleManager.get_for_display(display);
    manager.connect('notify::dark', () => setDark(manager.get_dark()));
    setDark(manager.get_dark());
}

function addSheets(dir, light, dark) {
    const key = `${dir}/${light}`;
    if (loaded.has(key))
        return;
    const display = Gdk.Display.get_default();
    if (!display)
        return;
    addFonts(dir);
    Gtk.StyleContext.add_provider_for_display(display, sheet(dir, light),
        Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION - 1);
    followDark(display, sheet(dir, dark));
    loaded.add(key);
}

export function applyToApp(dir) {
    addSheets(dir, 'sedge.css', 'sedge-dark.css');
}

export function applyToWindow(window, dir) {
    addSheets(dir, 'sedge-scoped.css', 'sedge-scoped-dark.css');
    window.add_css_class('sedge');
}
