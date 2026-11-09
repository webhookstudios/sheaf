import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const POLL_MS = 80;
// The pointer must stay within this many pixels to count as holding still.
const STILL_RADIUS = 12;
// Once the highlight is showing, small hand movement should not cancel it.
const ARMED_RADIUS = 28;

// Watches a window while it is being dragged. Holding it still over another
// window for `delay` ms arms a join and highlights that window; so does
// simply being over another group's tab bar. Releasing while armed joins
// them, moving away disarms.
//
// `pickTarget(window, x, y)` returns what the pointer is over as
// `{target, rect, onBar}`, or null when there is nothing to join.
export class HoverJoin {
    constructor({getDelay, pickTarget}) {
        this._getDelay = getDelay;
        this._pickTarget = pickTarget;
        this._window = null;
        this._timer = 0;
        this._indicator = null;
    }

    begin(window) {
        this.end();
        this._window = window;
        this._candidate = null;
        this._armed = null;
        this._timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, POLL_MS, () => {
            this._poll();
            return GLib.SOURCE_CONTINUE;
        });
    }

    // Stops watching. Returns the window to join with if the drag ended
    // while armed, otherwise null.
    end() {
        if (this._timer)
            GLib.source_remove(this._timer);
        this._timer = 0;
        this._indicator?.destroy();
        this._indicator = null;

        const target = this._armed;
        this._window = null;
        this._candidate = null;
        this._armed = null;
        return target ?? null;
    }

    _poll() {
        const [x, y] = global.get_pointer();
        const hit = this._pickTarget(this._window, x, y);
        if (!hit) {
            this._candidate = null;
            this._setArmed(null);
            return;
        }

        const now = GLib.get_monotonic_time() / 1000;
        const held = this._candidate;
        const radius = this._armed ? ARMED_RADIUS : STILL_RADIUS;
        if (held?.target !== hit.target ||
            Math.hypot(x - held.x, y - held.y) > radius)
            this._candidate = {target: hit.target, x, y, since: now};

        const armed = hit.onBar || now - this._candidate.since >= this._getDelay();
        this._setArmed(armed ? hit : null);
    }

    _setArmed(hit) {
        this._armed = hit?.target ?? null;
        if (!hit) {
            this._indicator?.destroy();
            this._indicator = null;
            return;
        }

        if (!this._indicator) {
            // Drawn above all windows, because the dragged window covers
            // the one it is being held over.
            this._indicator = new St.Bin({
                style_class: 'sheaf-drop-indicator',
                child: new St.Label({
                    style_class: 'sheaf-drop-label',
                    text: 'Release to group',
                    x_align: Clutter.ActorAlign.CENTER,
                    y_align: Clutter.ActorAlign.CENTER,
                }),
            });
            Main.uiGroup.add_child(this._indicator);
        }
        this._indicator.set_position(hit.rect.x, hit.rect.y);
        this._indicator.set_size(hit.rect.width, hit.rect.height);
    }
}
