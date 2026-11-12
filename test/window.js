#!/usr/bin/gjs -m
// A plain window for the tests to group: gjs -m test/window.js "Title"
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';
import system from 'system';

Gtk.init();
const window = new Gtk.Window({
    title: system.programArgs[0] ?? 'Sheaf test',
    default_width: 640,
    default_height: 420,
});
const loop = new GLib.MainLoop(null, false);
window.connect('close-request', () => {
    loop.quit();
    return false;
});
window.present();
loop.run();
