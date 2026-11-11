#!/bin/sh
# Builds the release zip in dist/, ready for `gnome-extensions install`.
set -e

UUID=sheaf@webhookstudios.github.io
ROOT="$(cd "$(dirname "$0")" && pwd)"

mkdir -p "$ROOT/dist"
gnome-extensions pack --force --out-dir "$ROOT/dist" \
    --extra-source=group.js \
    --extra-source=tabBar.js \
    --extra-source=hoverJoin.js \
    --extra-source=addMenu.js \
    --extra-source=sedge \
    "$ROOT/$UUID"

echo "Built $ROOT/dist/$UUID.shell-extension.zip"
