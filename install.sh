#!/bin/bash
# Inkwell installer — starts the helper server straight from THIS project folder
# (serves the page + your videos + battery), as a launchd agent that runs at
# login and restarts if it dies. No files are copied anywhere.
#
# Setup is just: drop videos into ./assets, then run ./install.sh
#
#   ./install.sh          # start/refresh the helper for this project
set -euo pipefail

SRC="$(cd "$(dirname "$0")" && pwd)"      # this project folder = the server root
LABEL="com.harshit.inkwell"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
PORT=8787

NODE="$(command -v node || true)"
[ -n "$NODE" ] || { echo "✗ Node.js not found. Install it (https://nodejs.org) and re-run." >&2; exit 1; }
mkdir -p "$SRC/assets"
if ! find "$SRC/assets" -maxdepth 1 -type f \( -iname '*.mp4' -o -iname '*.mov' -o -iname '*.webm' -o -iname '*.m4v' \) | grep -q .; then
  echo "! No videos in $SRC/assets yet — drop some in, then reload the wallpaper."
fi

echo "→ Writing launchd agent: $PLIST"
mkdir -p "$HOME/Library/LaunchAgents"
cat > "$PLIST" <<PLISTEOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE</string>
    <string>$SRC/server.mjs</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$SRC/inkwell.log</string>
  <key>StandardErrorPath</key><string>$SRC/inkwell.err.log</string>
</dict>
</plist>
PLISTEOF

echo "→ (Re)starting the helper"
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST" 2>/dev/null || true
launchctl kickstart -k "gui/$(id -u)/$LABEL"

sleep 1
if curl -fsS "http://localhost:$PORT/battery.json" >/dev/null 2>&1; then
  echo "✓ Helper up: $(curl -fsS "http://localhost:$PORT/videos.json" | head -c 120)…"
else
  echo "! Helper not responding yet — check $SRC/inkwell.err.log"
fi

cat <<DONE

✓ Installed. In Plash, set the website URL to:
      http://localhost:$PORT/index.html          (halftone)
      http://localhost:$PORT/index.html?mode=panel&panels=lite   (manga page)

  Add or change wallpapers anytime: drop videos into
      $SRC/assets
  then reload the wallpaper in Plash.

  Remove:  ./uninstall.sh
DONE
