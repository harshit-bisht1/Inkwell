#!/bin/bash
# Inkwell asset optimizer (OPTIONAL) — transcodes a folder of raw videos into
# lightweight 720p/30fps copies in this project's ./assets, which Inkwell serves.
#
# You don't need this if your videos are already a reasonable size: just drop
# them straight into ./assets. Use this only to shrink big/4K files.
#
#   ./build-assets.sh <sourceDir>     # transcode every video in sourceDir -> ./assets
#   ./build-assets.sh                 # default sourceDir = ./source
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SRC="${1:-$SCRIPT_DIR/source}"
OUT="$SCRIPT_DIR/assets"

command -v ffmpeg >/dev/null || { echo "✗ ffmpeg not found. Install:  brew install ffmpeg" >&2; exit 1; }
if [ ! -d "$SRC" ]; then
  echo "✗ Source folder not found: $SRC"
  echo "  Pass one:  ./build-assets.sh /path/to/your/videos"
  echo "  (Or skip this script entirely and just drop videos into $OUT)"
  exit 1
fi
mkdir -p "$OUT"

shopt -s nullglob nocaseglob
files=("$SRC"/*.mp4 "$SRC"/*.mov "$SRC"/*.webm "$SRC"/*.m4v)
shopt -u nullglob nocaseglob
[ ${#files[@]} -gt 0 ] || { echo "No videos found in $SRC"; exit 0; }

n=0; built=0; skipped=0
for src in "${files[@]}"; do
  n=$((n+1))
  base="$(basename "${src%.*}")"
  dst="$OUT/$base.mp4"
  if [ -f "$dst" ]; then echo "  · exists: $base.mp4"; skipped=$((skipped+1)); continue; fi
  echo "→ [$n/${#files[@]}] $base"
  ffmpeg -y -loglevel error -i "$src" \
    -an -vf "scale=-2:720:flags=lanczos,fps=30" \
    -c:v libx264 -profile:v high -pix_fmt yuv420p -crf 24 -preset veryfast \
    -movflags +faststart "$dst" && built=$((built+1))
done

echo ""
echo "✓ Done. built=$built skipped=$skipped → $OUT"
echo "  Reload the wallpaper in Plash."
