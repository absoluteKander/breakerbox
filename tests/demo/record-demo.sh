#!/bin/bash
# Record short clips of Breaker Box from the fake lab, never from a real
# setup. Run from the repo root with Breaker Box enabled in a running
# omarchy-shell, on a monitor showing only the wallpaper. Needs
# gpu-screen-recorder (the recorder behind `omarchy capture screenrecording`),
# ffmpeg, wtype and hyprctl.
#
#   tests/demo/record-demo.sh          # trip: a crash is caught -> docs/demo.{mp4,gif}
#   tests/demo/record-demo.sh setup    # first run: adding a service -> docs/demo-add.{mp4,gif}
#   OUTPUT=HDMI-A-1 tests/demo/record-demo.sh
#
# The .mp4 is 2x for posting; the .gif is native size for the README. It
# moves your mouse cursor and types into the dialog for about 20 seconds.
# Like screenshots.sh, it swaps in a demo config and dummy keyring entries,
# and puts everything back on exit.
set -euo pipefail

MODE=${1:-trip}
case $MODE in trip | setup) ;; *) echo "usage: $0 [trip|setup]" >&2; exit 2 ;; esac
ID=io.github.absolutekander.breakerbox
OUTPUT=${OUTPUT:-DP-1}
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
CONF=${XDG_CONFIG_HOME:-$HOME/.config}/breakerbox/config.json
WORK=$(mktemp -d)
SHELL_PATH=${OMARCHY_PATH:-/usr/share/omarchy}/shell
ipc() { qs ipc -p "$SHELL_PATH" call "$@"; }
# Wait for a condition, but never forever: fail with a message after 30 s.
wait_for() { local what=$1 t=0; shift; until "$@" >/dev/null 2>&1; do (( t++ < 150 )) || { echo "timed out waiting for $what" >&2; exit 1; }; sleep 0.2; done; }
status_has() { ipc "$ID" status 2>/dev/null | grep -qi "$1"; }
cursor() { hyprctl eval "hl.dispatch(hl.dsp.cursor.move({ x = $1, y = $2 }))" >/dev/null; }   # Hyprland 0.56+ Lua dispatch
type_slow() { wtype -d 45 "$1"; }

read -r MX MY MW MH < <(hyprctl monitors -j | jq -r --arg o "$OUTPUT" '.[] | select(.name == $o) | "\(.x) \(.y) \(.width) \(.height)"')
[ -n "${MW:-}" ] || { echo "no monitor named $OUTPUT" >&2; exit 1; }
if [ "$MODE" = trip ]; then
    CW=400 CH=520 CX=$((MX + MW - 400)) CY=$MY               # bar icons + panel
    OUT=demo CAPTION="You can monitor your homelab in real time"
else
    CW=600 CH=720 CX=$((MX + (MW - 600) / 2)) CY=$((MY + (MH - 720) / 2))   # the centred dialog
    OUT=demo-add CAPTION="Adding a service is simple and gets added instantly"
fi
ICON_X=${ICON_X:-$((MX + MW - 157))} ICON_Y=${ICON_Y:-$((MY + 13))}   # Breaker Box icon in the bar
DEMO_REFS="demo-pve demo-docker demo-nas"
SETUP_REF=pve   # where saving the setup demo's fake key puts it

MOCK_PID="" REC_PID="" HAD_CONF=0 SWAPPED=0 OWN_SETUP_REF=0
cleanup() {
    [ -n "$REC_PID" ] && kill -INT "$REC_PID" 2>/dev/null && wait "$REC_PID" 2>/dev/null || true
    [ -n "$MOCK_PID" ] && kill "$MOCK_PID" 2>/dev/null || true
    ipc "$ID" close >/dev/null 2>&1 || true
    ipc shell hide "$ID" >/dev/null 2>&1 || true
    if [ "$SWAPPED" = 1 ]; then
        if [ "$HAD_CONF" = 1 ]; then cp "$WORK/real-config.json" "$CONF" && chmod 600 "$CONF"; else rm -f "$CONF"; fi
    fi
    for r in $DEMO_REFS; do secret-tool clear service breakerbox ref "$r" 2>/dev/null || true; done
    [ "$OWN_SETUP_REF" = 1 ] && { secret-tool clear service breakerbox ref "$SETUP_REF" 2>/dev/null || true; }
    rm -rf "$WORK"
    echo "restored your config and removed the demo keys"
}
trap cleanup EXIT

if [ -f "$CONF" ]; then
    cp "$CONF" "$WORK/real-config.json" && cmp -s "$CONF" "$WORK/real-config.json" \
        || { echo "couldn't back up $CONF, not touching it" >&2; exit 1; }
    HAD_CONF=1
fi
if [ "$MODE" = setup ]; then
    # Never touch a real keyring entry that happens to share the name.
    secret-tool lookup service breakerbox ref "$SETUP_REF" >/dev/null 2>&1 \
        && { echo "a keyring entry named '$SETUP_REF' already exists; not recording over it" >&2; exit 1; }
    OWN_SETUP_REF=1
fi
python3 -I "$ROOT/tests/demo/mocklab.py" 8787 --healthy & MOCK_PID=$!
wait_for "the fake lab" curl -s -m 1 -o /dev/null http://127.0.0.1:8787/api/status-page/homelab
mkdir -p "$(dirname "$CONF")"
if [ "$MODE" = trip ]; then
    for r in $DEMO_REFS; do printf 'demo-not-a-real-key' | secret-tool store --label="Breaker Box: $r (demo)" service breakerbox ref "$r"; done
    SWAPPED=1; cp "$ROOT/tests/demo/demo-config.json" "$CONF"; chmod 600 "$CONF"
    wait_for "all green" status_has "all quiet"
else
    SWAPPED=1; printf '{ "instances": [] }\n' > "$CONF"; chmod 600 "$CONF"
    wait_for "an empty setup" status_has "nothing wired up"
fi
cursor $((MX + MW / 2)) $((MY + MH - 200)); sleep 1     # also focuses this monitor

gpu-screen-recorder -w "${CW}x${CH}+${CX}+${CY}" -f 60 -k auto -fm cfr -o "$WORK/raw.mp4" 2>/dev/null & REC_PID=$!
wait_for "the recorder" test -s "$WORK/raw.mp4"

if [ "$MODE" = trip ]; then
    sleep 2.5                                         # all quiet
    kill -USR1 "$MOCK_PID"; ipc "$ID" refresh >/dev/null   # jellyfin crashes
    wait_for "the trip" status_has "tripped"
    sleep 1.5
    cursor "$ICON_X" "$ICON_Y"                        # hover: the tooltip says what tripped
    sleep 2.5
    ipc "$ID" open >/dev/null                         # opens straight onto the problem
    sleep 4.5
    kill -USR1 "$MOCK_PID"; ipc "$ID" refresh >/dev/null   # jellyfin is back
    wait_for "the recovery" status_has "all quiet"
    sleep 2.5
    ipc "$ID" close >/dev/null
    cursor $((MX + MW / 2)) $((MY + MH - 200))
    sleep 1.5
else
    sleep 1
    ipc shell summon "$ID" '{"add":true}' >/dev/null  # first run opens on "Add a service"
    sleep 2
    type_slow "pve";                       wtype -k Tab; sleep 0.3
    type_slow "http://pve.localhost:8787"; wtype -k Tab; sleep 0.3
    type_slow "monitor@pve!bar";           wtype -k Tab; sleep 0.3
    type_slow "pve";                       wtype -k Tab; sleep 0.3
    type_slow "demo-not-a-real-key";       sleep 1        # shows as dots
    wtype -k Return                                       # test the connection, then save
    wait_for "the save" grep -q '"pve"' "$CONF"
    wait_for "the first poll" status_has "all quiet"
    sleep 3.5                                             # "Saved pve." and the green dot in the list
    ipc shell hide "$ID" >/dev/null
    sleep 1
fi
kill -INT "$REC_PID"; wait "$REC_PID" 2>/dev/null || true; REC_PID=""

mkdir -p "$ROOT/docs"
"$ROOT/tests/demo/finish-clip.sh" "$WORK/raw.mp4" "$ROOT/docs/$OUT" "$CAPTION"
