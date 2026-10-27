#!/bin/bash
# Make the landing page's icons and favicons, and a link-preview card (og.png) for the landing
# page and each app, so a link texted to a parent shows a proper preview.
# Run after tools/gen-icons.sh (the app cards use the app icons). Needs rsvg-convert and python3.
# The card text is set in Avenir Next, which ships with macOS.
set -euo pipefail
cd "$(dirname "$0")/.."
tmp=$(mktemp)
trap 'rm -f "$tmp"' EXIT
art=$(sed '/^<!--/,/-->$/d' tools/site-art.svg)
BG='<defs><radialGradient id="sbg" cx=".5" cy=".3" r=".85"><stop offset="0" stop-color="#3D352B"/><stop offset="1" stop-color="#16120E"/></radialGradient></defs><rect width="1024" height="1024" fill="url(#sbg)"/>'

mkdir -p web/icons
printf '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024">%s%s</svg>' "$BG" "$art" > "$tmp"
rsvg-convert -w 180 -h 180 "$tmp" -o web/icons/apple-touch-icon.png
rsvg-convert -w 192 -h 192 "$tmp" -o web/icons/icon-192.png
rsvg-convert -w 512 -h 512 "$tmp" -o web/icons/icon-512.png
printf '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024">%s<g transform="translate(102 102) scale(.8)">%s</g></svg>' "$BG" "$art" > "$tmp"
rsvg-convert -w 512 -h 512 "$tmp" -o web/icons/maskable-512.png

# Browser tabs: no background, cropped to the cards so they fill the little square.
printf '<svg xmlns="http://www.w3.org/2000/svg" viewBox="64 106 896 896">%s</svg>\n' "$art" > web/icons/favicon.svg
for s in 16 32 48; do rsvg-convert -w $s -h $s web/icons/favicon.svg -o "web/icons/favicon-$s.png"; done
python3 -I - web/icons/favicon-16.png web/icons/favicon-32.png web/icons/favicon-48.png web/favicon.ico <<'PY'
# An .ico is a small directory of images; modern ones may simply hold PNGs.
import struct, sys
*pngs, out = sys.argv[1:]
blobs = [open(p, 'rb').read() for p in pngs]
head = struct.pack('<HHH', 0, 1, len(blobs))
offset, dirs = 6 + 16 * len(blobs), b''
for b in blobs:
    w = struct.unpack('>I', b[16:20])[0]
    dirs += struct.pack('<BBBBHHII', w % 256, w % 256, 0, 0, 1, 32, len(b), offset)
    offset += len(b)
open(out, 'wb').write(head + dirs + b''.join(blobs))
PY

# card <out> <bg> <accent> <icon-svg-content> <title> <line1> <line2>
card() {
  local out=$1 bg=$2 accent=$3 icon=$4 title=$5 l1=$6 l2=$7 size=64
  # Long names get smaller type so they stay clear of the right edge.
  if [ ${#title} -gt 16 ]; then size=54; fi
  cat > "$tmp" <<SVG
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="1200" height="630" viewBox="0 0 1200 630">
  <defs>
    <radialGradient id="cbg" cx=".15" cy=".2" r="1"><stop offset="0" stop-color="#ffffff" stop-opacity=".09"/><stop offset="1" stop-color="#ffffff" stop-opacity="0"/></radialGradient>
    <clipPath id="round"><rect x="0" y="0" width="1024" height="1024" rx="230"/></clipPath>
  </defs>
  <rect width="1200" height="630" fill="$bg"/>
  <rect width="1200" height="630" fill="url(#cbg)"/>
  <g transform="translate(90 165) scale(.293)"><g clip-path="url(#round)">$icon</g></g>
  <text x="450" y="268" font-family="Avenir Next" font-weight="700" font-size="$size" fill="#FFFFFF">$title</text>
  <text x="450" y="336" font-family="Avenir Next" font-weight="500" font-size="31" fill="#FFFFFF" fill-opacity=".82">$l1</text>
  <text x="450" y="380" font-family="Avenir Next" font-weight="500" font-size="31" fill="#FFFFFF" fill-opacity=".82">$l2</text>
  <rect x="450" y="430" width="64" height="6" rx="3" fill="$accent"/>
  <text x="450" y="486" font-family="Avenir Next" font-weight="600" font-size="26" fill="#FFFFFF" fill-opacity=".6">kidapps.exe.xyz</text>
</svg>
SVG
  rsvg-convert "$tmp" -o "$out"
}
png() { printf '<image width="1024" height="1024" href="data:image/png;base64,%s"/>' "$(base64 < "$1" | tr -d '\n')"; }

card web/og.png '#1E1A15' '#D9A82C' "$BG$art" 'Kid Apps' 'Practice games that sneak in' 'math and reading.'
card web/dm/og.png '#1A2622' '#D9A82C' "$(png web/dm/icons/icon-512.png)" 'Pinehurst DM Academy' 'Dungeon Master training: dice math, rules,' 'and a Forge to build dungeons for friends.'
card web/chain/og.png '#1d1240' '#ff4f9a' "$(png web/chain/icons/icon-512.png)" 'Chain Reaction' 'Times tables up to 12 × 12. String right' 'answers together to earn screen time.'
card web/signal/og.png '#0b1020' '#5be3a0' "$(png web/signal/icons/icon-512.png)" 'Signal' 'A 1986 radio mystery. Read the clues' 'and crack the codes.'
echo "site icons, favicons and 4 preview cards"
