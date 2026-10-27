#!/bin/bash
# Make each app's home-screen icons and iPad launch screens, and write the matching
# <link> tags into its index.html between the "splash" markers.
# Needs rsvg-convert (brew install librsvg). Safe to re-run.
set -euo pipefail
cd "$(dirname "$0")/.."

# iPad screens in CSS points (width height). Each gets a portrait and a landscape image at @2x.
IPADS="744 1133
768 1024
810 1080
820 1180
834 1112
834 1194
834 1210
1024 1366
1032 1376"

# art <app> prints the icon artwork as an SVG <g> on a 1024 square, without background.
art() {
  case "$1" in
    dm)
      local b64
      b64=$(base64 < web/dm/assets/crest.png | tr -d '\n')
      printf '<image x="72" y="72" width="880" height="880" href="data:image/png;base64,%s"/>' "$b64"
      ;;
    chain)
      cat <<'SVG'
<defs>
  <linearGradient id="x" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="#ffd23f"/><stop offset=".55" stop-color="#ff8a3d"/><stop offset="1" stop-color="#ff4f9a"/>
  </linearGradient>
  <radialGradient id="glow" cx=".5" cy="1.1" r=".8">
    <stop offset="0" stop-color="#ff4f9a" stop-opacity=".55"/><stop offset="1" stop-color="#ff4f9a" stop-opacity="0"/>
  </radialGradient>
</defs>
<rect width="1024" height="1024" fill="url(#glow)"/>
<g transform="rotate(45 512 512)">
  <rect x="452" y="182" width="120" height="660" rx="60" fill="url(#x)"/>
  <rect x="182" y="452" width="660" height="120" rx="60" fill="url(#x)"/>
</g>
<circle cx="212" cy="236" r="16" fill="#3fe0ff"/>
<circle cx="820" cy="212" r="12" fill="#fff3e4"/>
<circle cx="842" cy="760" r="18" fill="#3fe0ff"/>
<circle cx="190" cy="800" r="11" fill="#ffd23f"/>
SVG
      ;;
  esac
}

bg() { case "$1" in dm) echo '#1A2622' ;; chain) echo '#160d2c' ;; esac; }

for app in dm chain; do
  out=web/$app/icons
  mkdir -p "$out" "web/$app/splash"
  rm -f "web/$app/splash/"*.png
  tmp=$(mktemp)
  # Full-bleed square: iOS rounds the corners itself, and a transparent corner would turn black.
  printf '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024"><rect width="1024" height="1024" fill="%s"/>%s</svg>' "$(bg $app)" "$(art $app)" > "$tmp"
  rsvg-convert -w 180 -h 180 "$tmp" -o "$out/apple-touch-icon.png"
  rsvg-convert -w 192 -h 192 "$tmp" -o "$out/icon-192.png"
  rsvg-convert -w 512 -h 512 "$tmp" -o "$out/icon-512.png"
  rsvg-convert -w 32 -h 32 "$tmp" -o "$out/favicon-32.png"
  # Maskable: artwork inside the central 80% safe zone.
  printf '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024"><rect width="1024" height="1024" fill="%s"/><g transform="translate(102 102) scale(.8)">%s</g></svg>' "$(bg $app)" "$(art $app)" > "$tmp"
  rsvg-convert -w 512 -h 512 "$tmp" -o "$out/maskable-512.png"

  links=""
  while read -r w h; do
    for orient in portrait landscape; do
      if [ "$orient" = portrait ]; then pw=$((w * 2)); ph=$((h * 2)); else pw=$((h * 2)); ph=$((w * 2)); fi
      size=$(( (pw < ph ? pw : ph) * 28 / 100 ))
      x=$(( (pw - size) / 2 )); y=$(( (ph - size) / 2 ))
      s=$(awk "BEGIN{print $size/1024}")
      printf '<svg xmlns="http://www.w3.org/2000/svg" width="%d" height="%d"><rect width="100%%" height="100%%" fill="%s"/><g transform="translate(%d %d) scale(%s)">%s</g></svg>' \
        "$pw" "$ph" "$(bg $app)" "$x" "$y" "$s" "$(art $app)" > "$tmp"
      name="ipad-${w}x${h}-$orient.png"
      rsvg-convert "$tmp" -o "web/$app/splash/$name"
      links="$links<link rel=\"apple-touch-startup-image\" media=\"(device-width: ${w}px) and (device-height: ${h}px) and (-webkit-device-pixel-ratio: 2) and (orientation: $orient)\" href=\"splash/$name\">
"
    done
  done <<EOF
$IPADS
EOF
  rm -f "$tmp"

  # Replace whatever sits between the markers with the fresh tags.
  html=web/$app/index.html
  printf '%s' "$links" > "$html.links"
  awk -v f="$html.links" '
    /<!-- splash:start -->/ { print; while ((getline l < f) > 0) print l; skip = 1; next }
    /<!-- splash:end -->/ { skip = 0 }
    !skip { print }
  ' "$html" > "$html.new"
  mv "$html.new" "$html"
  rm -f "$html.links"
  echo "$app: icons and $(ls web/$app/splash | wc -l | tr -d ' ') launch screens"
done
