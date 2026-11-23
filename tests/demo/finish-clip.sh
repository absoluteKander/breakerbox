#!/bin/bash
# Turn a raw recording into the published clip: a short title card (the
# Breaker Box mark, the name and a one-line caption) that crossfades into the
# recording. Writes <out>.mp4 at 2x (for posting) and <out>.gif at native size
# (for the README). Called by record-demo.sh; needs ffmpeg and ImageMagick.
#
#   tests/demo/finish-clip.sh raw.mp4 docs/demo "You can monitor your homelab in real time"
set -euo pipefail

RAW=$1 OUT=$2 CAPTION=$3
BG=${BG:-#1F1F28} FG=${FG:-#DCD7BA}          # the panel's colours in the default theme
CARD_S=2.2 FADE_S=0.4
FONT=$(fc-match -f '%{file}' 'monospace:bold')
WORK=$(mktemp -d); trap 'rm -rf "$WORK"' EXIT

IFS=x read -r W H < <(ffprobe -v error -select_streams v:0 -show_entries stream=width,height -of csv=p=0:s=x "$RAW")
[ -n "${H:-}" ] || { echo "couldn't read the size of $RAW" >&2; exit 1; }
W2=$((W * 2)) H2=$((H * 2))

# The mark: four solid bars on an 11-unit grid, the third one raised.
U=$((W2 / 40)) ; [ "$U" -ge 6 ] || U=6
MARK=""
for i in 0 1 2 3; do
    y=$([ $i = 2 ] && echo 1 || echo 3)
    MARK+="rectangle $((i * 3 * U)),$((y * U)) $((i * 3 * U + 2 * U - 1)),$((y * U + 7 * U - 1)) "
done
magick -size $((11 * U))x$((11 * U)) xc:none -fill "$FG" -draw "$MARK" "$WORK/mark.png"
magick -background none -fill "$FG" -font "$FONT" -pointsize $((U * 3)) label:"Breaker Box" "$WORK/title.png"
magick -background none -fill "$FG" -font "$FONT" -pointsize $((U * 2)) -size $((W2 * 8 / 10))x -gravity center caption:"$CAPTION" "$WORK/caption.png"
magick "$WORK/mark.png" "$WORK/title.png" \( -size 1x$((U * 3)) xc:none \) "$WORK/caption.png" \
    -background none -gravity center -append "$WORK/stack.png"
magick -size "${W2}x${H2}" xc:"$BG" "$WORK/stack.png" -gravity center -composite "$WORK/card.png"

ffmpeg -y -loglevel error -loop 1 -framerate 60 -t "$CARD_S" -i "$WORK/card.png" -i "$RAW" -filter_complex \
    "[0:v]format=yuv420p,setsar=1[c];[1:v]fps=60,scale=${W2}:${H2}:flags=lanczos,format=yuv420p,setsar=1[v];[c][v]xfade=transition=fade:duration=${FADE_S}:offset=$(awk -v a="$CARD_S" -v b="$FADE_S" 'BEGIN { print a - b }')[o]" \
    -map "[o]" -c:v libx264 -preset slow -crf 18 -pix_fmt yuv420p -movflags +faststart -an "$OUT.mp4"
ffmpeg -y -loglevel error -i "$OUT.mp4" -vf "fps=15,scale=${W}:${H}:flags=lanczos,split[a][b];[a]palettegen=max_colors=256:stats_mode=full[p];[b][p]paletteuse=dither=none" "$OUT.gif"
ls -l "$OUT.mp4" "$OUT.gif"
