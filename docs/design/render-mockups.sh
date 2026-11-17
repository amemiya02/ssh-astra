#!/bin/sh
# Renders docs/design/mockups.html to PNGs with headless Chrome (macOS path by default).
# Usage: CHROME=/path/to/chrome docs/design/render-mockups.sh
set -eu
dir=$(cd "$(dirname "$0")" && pwd)
chrome=${CHROME:-"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"}
for screen in main bottom editor known mismatch; do
  for theme in light dark; do
    "$chrome" --headless=new --disable-gpu --hide-scrollbars --force-device-scale-factor=1 \
      --window-size=1440,900 --screenshot="$dir/$screen-$theme.png" \
      "file://$dir/mockups.html?screen=$screen&theme=$theme" >/dev/null 2>&1
  done
done
echo "rendered to $dir"
