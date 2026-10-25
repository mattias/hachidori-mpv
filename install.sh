#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-or-later
# Installs hachidori-mpv into mpv's config folder (default: ~/.config/mpv).
#
#   ./install.sh
#   ./install.sh --mpv-dir ~/.var/app/io.mpv.Mpv/config/mpv
#   ./install.sh --release 0.3.1
set -eu

here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
mpv_dir="${XDG_CONFIG_HOME:-$HOME/.config}/mpv"
release=""
while [ $# -gt 0 ]; do
    case "$1" in
        --mpv-dir) mpv_dir=$2; shift 2 ;;
        --release) release=$2; shift 2 ;;
        *) echo "unknown option: $1" >&2; exit 2 ;;
    esac
done

command -v node >/dev/null 2>&1 || { echo "Node.js 18 or newer is needed to install (https://nodejs.org)." >&2; exit 1; }
major=$(node -p 'process.versions.node.split(".")[0]')
[ "$major" -ge 18 ] || { echo "Node.js 18 or newer is needed; this is $(node --version)." >&2; exit 1; }

source="$here/scripts/hachidori-mpv"
target="$mpv_dir/scripts/hachidori-mpv"
mkdir -p "$mpv_dir/scripts" "$mpv_dir/script-opts"

if [ "$(cd "$source" && pwd -P)" != "$( [ -d "$target" ] && cd "$target" && pwd -P)" ]; then
    echo "Copying the plugin to $target"
    mkdir -p "$target"
    (cd "$source" && tar --exclude=./overlay/node_modules --exclude=./overlay/hachidori -cf - .) | (cd "$target" && tar -xf -)
fi

conf="$mpv_dir/script-opts/hachidori-mpv.conf"
if [ ! -e "$conf" ]; then
    cp "$here/script-opts/hachidori-mpv.conf" "$conf"
    echo "Wrote $conf"
else
    echo "Kept your $conf"
fi

cd "$target/overlay"
echo "Installing the overlay's packages…"
npm install --omit=dev --ignore-scripts --no-audit --no-fund
node fetch-electron.mjs
if [ -n "$release" ]; then node prepare-hachidori.mjs --release "$release"; else node prepare-hachidori.mjs; fi

for tool in xwininfo xprop ffmpeg; do
    command -v "$tool" >/dev/null 2>&1 || echo "Note: $tool was not found; install it (see README)."
done

echo
echo "hachidori-mpv is installed. Open a video with Japanese subtitles in mpv;"
echo "keep your browser's Hachidori (Settings → Sharing) and Anki running."
