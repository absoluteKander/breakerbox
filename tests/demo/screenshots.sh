#!/bin/bash
# Regenerate preview.png and docs/screenshots/* from the fake lab, never from
# a real setup. Run from the repo root, with Breaker Box enabled in a running
# omarchy-shell. Needs grim, wtype and ImageMagick.
#
#   tests/demo/screenshots.sh            # panel is on DP-1
#   OUTPUT=HDMI-A-1 tests/demo/screenshots.sh
#
# It temporarily swaps your config for tests/demo/demo-config.json and adds
# three dummy keyring entries; both are restored/removed on exit, even on
# failure. It sends a few keystrokes (←/→) to the panel while it's open.
set -euo pipefail

ID=io.github.absolutekander.breakerbox
OUTPUT=${OUTPUT:-DP-1}
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
CONF=${XDG_CONFIG_HOME:-$HOME/.config}/breakerbox/config.json
WORK=$(mktemp -d)
SHELL_PATH=${OMARCHY_PATH:-/usr/share/omarchy}/shell
BORDER=${BORDER:-#DCD7BA}   # the panel/dialog border colour in your theme
ipc() { qs ipc -p "$SHELL_PATH" call "$@"; }

MOCK_PID=""
HAD_CONF=0
cleanup() {
    [ -n "$MOCK_PID" ] && kill "$MOCK_PID" 2>/dev/null || true
    if [ "$HAD_CONF" = 1 ]; then cp "$WORK/real-config.json" "$CONF"; chmod 600 "$CONF"; else rm -f "$CONF"; fi
    for r in demo-pve demo-docker demo-nas; do secret-tool clear service breakerbox ref "$r" 2>/dev/null || true; done
    ipc "$ID" close >/dev/null 2>&1 || true
    rm -rf "$WORK"
    echo "restored your config and removed the demo keys"
}
trap cleanup EXIT

[ -f "$CONF" ] && { cp "$CONF" "$WORK/real-config.json"; HAD_CONF=1; }
python3 -I "$ROOT/tests/demo/mocklab.py" 8787 & MOCK_PID=$!
until curl -s -m 1 -o /dev/null http://127.0.0.1:8787/api/status-page/homelab; do sleep 0.3; done
for r in demo-pve demo-docker demo-nas; do printf 'demo-not-a-real-key' | secret-tool store --label="Breaker Box: $r (demo)" service breakerbox ref "$r"; done
mkdir -p "$(dirname "$CONF")"; cp "$ROOT/tests/demo/demo-config.json" "$CONF"; chmod 600 "$CONF"
until ipc "$ID" status 2>/dev/null | grep -q "2 tripped"; do sleep 1; done
sleep 1

# Crop to the panel's own border: first/last border pixel on row 300, and the
# last border pixel down column (left+130).
crop_panel() {
    local img=$1 out=$2 L R B
    read -r L R < <(magick "$img" -crop 1920x1+0+300 +repage txt:- | awk -F'[,: ]+' -v c="$BORDER" '$0 ~ c {print $1}' | awk 'NR==1{f=$1}{l=$1}END{print f, l}')
    B=$(magick "$img" -crop "1x1080+$((L + 130))+0" +repage txt:- | awk -F'[,: ]+' -v c="$BORDER" '$0 ~ c {print $2}' | tail -1)
    magick "$img" -crop "$((R - L + 1))x$((B + 1))+$L+0" +repage "$out"
}
shot() { # name, Left presses, Right presses
    ipc "$ID" open >/dev/null; sleep 1.5
    for _ in $(seq 1 "$2"); do wtype -k Left; sleep 0.4; done
    for _ in $(seq 1 "$3"); do wtype -k Right; sleep 0.4; done
    sleep 0.4; grim -o "$OUTPUT" "$WORK/$1.png"; ipc "$ID" close >/dev/null; sleep 0.6
    crop_panel "$WORK/$1.png" "$ROOT/docs/screenshots/$1.png"
    echo "docs/screenshots/$1.png"
}
mkdir -p "$ROOT/docs/screenshots"
shot portainer 0 0     # opens on the worst problem by itself
shot proxmox 1 0
shot kuma 0 2

# The add-service form (example placeholders, no addresses), cropped to its
# card. Kuma is dropped from the demo first, or its button shows greyed out
# (one Kuma is the limit) and reads like a bug in a screenshot.
jq '.instances |= map(select(.type != "uptimekuma"))' "$ROOT/tests/demo/demo-config.json" > "$CONF"; sleep 2
ipc shell summon "$ID" '{"add":true}' >/dev/null; sleep 1.5
FOCUSED=$(hyprctl monitors -j | jq -r '.[] | select(.focused) | .name')
grim -o "$FOCUSED" "$WORK/setup.png"; ipc shell hide "$ID" >/dev/null
read -r L R < <(magick "$WORK/setup.png" -crop 1920x1+0+540 +repage txt:- | awk -F'[,: ]+' -v c="$BORDER" '$0 ~ c {print $1}' | awk 'NR==1{f=$1}{l=$1}END{print f, l}')
read -r T B < <(magick "$WORK/setup.png" -crop 1x1080+960+0 +repage txt:- | awk -F'[,: ]+' -v c="$BORDER" '$0 ~ c {print $2}' | awk 'NR==1{f=$1}{l=$1}END{print f, l}')
magick "$WORK/setup.png" -crop "$((R - L + 1))x$((B - T + 1))+$L+$T" +repage "$ROOT/docs/screenshots/setup.png"
echo "docs/screenshots/setup.png"

# Marketplace card: hero panel + setup dialog on a plain background.
P="$ROOT/docs/screenshots/portainer.png"; magick "$ROOT/docs/screenshots/setup.png" -resize 96% "$WORK/s96.png"
H1=$(magick "$P" -format %h info:); H2=$(magick "$WORK/s96.png" -format %h info:); W2=$(magick "$WORK/s96.png" -format %w info:)
CH=$(( (H1 > H2 ? H1 : H2) + 110 ))
magick -size "1000x$CH" xc:'#15171c' "$P" -geometry "+50+$(( (CH - H1) / 2 ))" -composite \
    "$WORK/s96.png" -geometry "+$((1000 - 50 - W2))+$(( (CH - H2) / 2 ))" -composite "$ROOT/preview.png"
echo "preview.png"
