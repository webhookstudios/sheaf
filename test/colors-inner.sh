#!/bin/bash
# Second half of colors.sh, run inside the private D-Bus session.
set -u
PICKED='#7a2f5c'
FAILS=0

eval_js() {
    timeout 15 gdbus call --session --dest org.gnome.Shell --object-path /org/gnome/Shell \
        --method org.gnome.Shell.Eval "$1" 2>&1
}

# Starts the shell with the extension and schema from one unpacked package.
start_shell() {
    ln -sfn "$WORK/$1/usr/share/gnome-shell/extensions/$UUID" \
        "$XDG_DATA_HOME/gnome-shell/extensions/$UUID"
    export GSETTINGS_SCHEMA_DIR="$WORK/$1/usr/share/glib-2.0/schemas"
    echo "===== shell run: $1 =====" >> "$LOG"
    gnome-shell --headless --wayland --no-x11 --unsafe-mode --virtual-monitor 1280x800 \
        >> "$LOG" 2>&1 &
    SHELL_PID=$!
    for _ in $(seq 1 60); do
        eval_js 'Main.layoutManager._startingUp' | grep -q "'false'" && break
        sleep 0.5
    done
    sleep 2
    WIN_PIDS=()
    for title in 'Sheaf test A' 'Sheaf test B'; do
        WAYLAND_DISPLAY=wayland-0 GDK_BACKEND=wayland gjs -m "$ROOT/test/window.js" "$title" \
            >> "$LOG" 2>&1 &
        WIN_PIDS+=($!)
        sleep 1.5
    done
    sleep 2
}

stop_shell() {
    kill "${WIN_PIDS[@]}" 2>/dev/null
    kill "$SHELL_PID" 2>/dev/null
    wait "$SHELL_PID" 2>/dev/null
    sleep 1
}

# Groups the two test windows (unless restoring already did) and prints
# "version color bar-visible" for the group's tab bar.
read_bar() {
    eval_js "(() => {
        const ext = Main.extensionManager.lookup('$UUID');
        const sheaf = ext?.stateObj;
        if (!sheaf?._groups)
            return 'not-enabled ' + ext?.state;
        const [a, b] = global.display.list_all_windows()
            .filter(w => w.title?.startsWith('Sheaf test'))
            .sort((x, y) => x.title.localeCompare(y.title));
        if (!a || !b)
            return 'windows-missing';
        if (!sheaf._isTabbed(a) || !sheaf._isTabbed(b)) {
            sheaf._takeOut(b);
            sheaf._join([b], a, b);
        }
        return 'grouped';
    })()" > /dev/null
    sleep 1.5
    eval_js "(() => {
        const ext = Main.extensionManager.lookup('$UUID');
        const group = [...ext.stateObj._groups].find(g => g.windows.length > 1);
        if (!group)
            return 'no-group';
        const c = group._backdrop.get_theme_node().get_background_color();
        const hex = '#' + [c.red, c.green, c.blue].map(v => v.toString(16).padStart(2, '0')).join('');
        return ext.metadata['version-name'] + ' ' + hex + ' ' + group._backdrop.visible;
    })()" | sed -n "s/^(true, '\"\(.*\)\"')$/\1/p"
}

check() {
    local label=$1 want=$2 got=$3
    if [ "$(echo "$got" | cut -d' ' -f2)" = "$want" ] && [ "$(echo "$got" | cut -d' ' -f3)" = true ]; then
        echo "PASS  $label: $got"
    else
        echo "FAIL  $label: wanted $want, got '$got'"
        FAILS=$((FAILS + 1))
    fi
}

# Picks a color the same way the settings window does: through GSettings.
pick_color() {
    gjs -c "
        const Gio = imports.gi.Gio;
        const settings = new Gio.Settings({schema_id: 'org.gnome.shell.extensions.sheaf'});
        settings.set_string('bar-color', '$1');
        Gio.Settings.sync();"
}

# 1. Old package: default color, then a picked one applies at once.
start_shell old
DEFAULT=$(GSETTINGS_SCHEMA_DIR="$WORK/old/usr/share/glib-2.0/schemas" \
    gsettings get org.gnome.shell.extensions.sheaf bar-color | tr -d "'")
check "old package, default color" "$DEFAULT" "$(read_bar)"
pick_color "$PICKED"
sleep 2
check "old package, color picked in Settings" "$PICKED" "$(read_bar)"
stop_shell

# 2. Restart on the same files.
start_shell old
check "after a restart" "$PICKED" "$(read_bar)"
stop_shell

# 3. Update to the new package.
start_shell new
check "after updating to the new package" "$PICKED" "$(read_bar)"
echo "saved value: $(grep '^bar-color' "$XDG_CONFIG_HOME/glib-2.0/settings/keyfile")"
stop_shell

ERRORS=$(grep -c -E 'JS ERROR|sheaf.*(Error|error)' "$LOG")
echo "JS errors in the shell log: $ERRORS"
[ "$ERRORS" -eq 0 ] || grep -E 'JS ERROR|sheaf.*(Error|error)' "$LOG" | head -20
[ "$FAILS" -eq 0 ] && [ "$ERRORS" -eq 0 ] && echo "ALL PASSED" || { echo "$FAILS check(s) failed"; exit 1; }
