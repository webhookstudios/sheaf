#!/bin/bash
# Checks that the colors picked in Sheaf's settings stay through a restart and an update.
#
#   test/colors.sh [old.deb] [new.deb]
#
# Runs the packaged extension in a headless nested GNOME Shell with a throwaway HOME,
# three times in a row on the same saved settings:
#   1. old package: group two windows, pick a tab bar color the way Settings does,
#      and check the bar changes at once;
#   2. the same files after a restart: the bar still has the picked color;
#   3. the new package, as after an update: the bar still has the picked color.
# Defaults: the two newest packages in dist/.
#
# Needs: gnome-shell, dbus-run-session, glib-compile-schemas, gdbus, gjs, dpkg-deb.
set -u

UUID=sheaf@webhookstudios.github.io
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
mapfile -t DEBS < <(ls "$ROOT"/dist/sheaf_*_all.deb | sort -V)
OLD_DEB="${1:-${DEBS[-2]}}"
NEW_DEB="${2:-${DEBS[-1]}}"

WORK="${WORK:-$(mktemp -d)}"
for name in old new; do
    deb=$([ $name = old ] && echo "$OLD_DEB" || echo "$NEW_DEB")
    dpkg-deb -x "$deb" "$WORK/$name"
    glib-compile-schemas "$WORK/$name/usr/share/glib-2.0/schemas"
done

export HOME="$WORK/home"
export GSETTINGS_BACKEND=keyfile
export XDG_CONFIG_HOME="$HOME/.config" XDG_DATA_HOME="$HOME/.local/share" XDG_CACHE_HOME="$HOME/.cache"
unset DISPLAY WAYLAND_DISPLAY
# A private runtime dir keeps the nested shell away from the real session.
# (It has to be a short path: the Wayland socket name has a length limit.)
XDG_RUNTIME_DIR="$(mktemp -d /tmp/shrun.XXXXXX)"
export XDG_RUNTIME_DIR
trap 'fusermount3 -uz "$XDG_RUNTIME_DIR/doc" 2>/dev/null; rm -rf "$XDG_RUNTIME_DIR" 2>/dev/null || true' EXIT
mkdir -p "$XDG_CONFIG_HOME/glib-2.0/settings" "$XDG_DATA_HOME/gnome-shell/extensions" "$XDG_CACHE_HOME"

cat > "$XDG_CONFIG_HOME/glib-2.0/settings/keyfile" <<EOF
[org/gnome/shell]
enabled-extensions=['$UUID']
welcome-dialog-last-shown-version='999'
EOF

LOG="$WORK/shell.log"
echo "old: $(basename "$OLD_DEB")  new: $(basename "$NEW_DEB")  work dir: $WORK"
export LOG WORK UUID ROOT
dbus-run-session -- bash "$ROOT/test/colors-inner.sh"
