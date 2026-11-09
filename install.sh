#!/bin/sh
# Installs Sheaf for the current user by copying it into the GNOME Shell
# extensions folder and compiling its settings schema.
set -e

UUID=sheaf@webhookstudios.github.io
SRC="$(cd "$(dirname "$0")" && pwd)/$UUID"
DEST="${XDG_DATA_HOME:-$HOME/.local/share}/gnome-shell/extensions/$UUID"

mkdir -p "$(dirname "$DEST")"
rm -rf "$DEST"
cp -r "$SRC" "$DEST"
glib-compile-schemas "$DEST/schemas"

cat <<EOF
Sheaf is installed in:
  $DEST

Log out and back in, then turn it on with:
  gnome-extensions enable $UUID
EOF
