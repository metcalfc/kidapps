#!/bin/bash
# Build kidapps for the VM and install or update it there, with Caddy in front.
#   deploy/deploy.sh [host]        (default host: kidapps.exe.xyz)
# Runs on macOS's bash 3.2. The first run also installs Caddy with the rate-limit plugin.
set -euo pipefail
cd "$(dirname "$0")/.."
HOST=${1:-kidapps.exe.xyz}
OUT=$(mktemp -d "${TMPDIR:-/tmp}/kidapps.XXXXXX")
trap 'rm -rf "$OUT"' EXIT

echo "building"
GOOS=linux GOARCH=amd64 CGO_ENABLED=0 go build -trimpath -ldflags='-s -w' -o "$OUT/kidapps" .
cp deploy/Caddyfile deploy/kidapps.service deploy/caddy.service "$OUT/"

echo "copying to $HOST"
scp -q "$OUT/kidapps" "$OUT/Caddyfile" "$OUT/kidapps.service" "$OUT/caddy.service" "$HOST:/tmp/"

# The remote script goes over stdin so nothing in it shows up in a process list.
ssh "$HOST" 'sudo bash -s' <<'REMOTE'
set -euo pipefail
cd /tmp
if ! /usr/local/bin/caddy list-modules 2>/dev/null | grep -q '^http.handlers.rate_limit$'; then
  echo "installing caddy with caddy-ratelimit"
  curl -fsSL -o caddy.new 'https://caddyserver.com/api/download?os=linux&arch=amd64&p=github.com/mholt/caddy-ratelimit'
  install -m 0755 caddy.new /usr/local/bin/caddy
  rm -f caddy.new
fi
/usr/local/bin/caddy validate --config Caddyfile --adapter caddyfile >/dev/null
install -m 0755 kidapps /usr/local/bin/kidapps
install -d -m 0755 /etc/caddy
install -m 0644 Caddyfile /etc/caddy/Caddyfile
install -m 0644 kidapps.service caddy.service /etc/systemd/system/
rm -f kidapps Caddyfile kidapps.service caddy.service
# The image ships nginx; it would fight Caddy for port 8000 if anyone pointed it there.
systemctl disable --now nginx 2>/dev/null || true
systemctl daemon-reload
systemctl enable kidapps caddy >/dev/null 2>&1
systemctl restart kidapps
systemctl restart caddy
sleep 1
systemctl is-active kidapps caddy
curl -fsS http://127.0.0.1:8000/healthz
REMOTE
echo "deployed to https://${HOST}/"
