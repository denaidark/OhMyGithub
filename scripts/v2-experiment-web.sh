#!/usr/bin/env bash
set -euo pipefail

timed() { local start=$SECONDS; "$@"; local rc=$?; printf '[timing] %s: %ss\n' "$1" "$((SECONDS-start))" >&2; return "$rc"; }
work="$RUNNER_TEMP/omgithub-v2"
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
session="$(cat "$work/session-id")"
[[ "$session" == ses_* ]] || { echo 'Missing V2 session ID' >&2; exit 1; }
port="${V2_WEB_PROXY_PORT:-4097}"
upstream="http://127.0.0.1:${V2_SERVER_PORT:-4096}"
nohup node "$script_dir/v2-experiment-proxy.mjs" "$port" "$session" "$upstream" > "$work/proxy.log" 2>&1 &
echo "$!" > "$work/proxy.pid"
for _ in {1..30}; do
  code="$(curl --silent --max-time 2 --output /dev/null --write-out '%{http_code}' "http://127.0.0.1:$port/" || true)"
  [[ "$code" == 200 ]] && break
  kill -0 "$(cat "$work/proxy.pid")" || { cat "$work/proxy.log"; exit 1; }
  sleep 1
done
[[ "${code:-}" == 200 ]] || { echo 'V2 proxy did not start' >&2; cat "$work/proxy.log" >&2; exit 1; }
asset=cloudflared-linux-amd64
if [[ "$RUNNER_OS" == macOS ]]; then
  asset=cloudflared-darwin-amd64
  [[ "$(uname -m)" == arm64 ]] && asset=cloudflared-darwin-arm64
fi
if [[ "$asset" == *linux* ]]; then
  timed curl --fail --silent --show-error --location --retry 3 \
    --output "$work/cloudflared" "https://github.com/cloudflare/cloudflared/releases/latest/download/$asset"
else
  timed curl --fail --silent --show-error --location --retry 3 \
    --output "$work/cloudflared.tgz" "https://github.com/cloudflare/cloudflared/releases/latest/download/$asset.tgz"
  timed tar -xzf "$work/cloudflared.tgz" -C "$work" cloudflared
fi
chmod 755 "$work/cloudflared"
nohup "$work/cloudflared" tunnel --no-autoupdate --url "http://127.0.0.1:$port" > "$work/tunnel.log" 2>&1 &
echo "$!" > "$work/tunnel.pid"
origin=''
for _ in {1..60}; do
  origin="$(sed -nE 's#^.*\|?[[:space:]]*(https://[a-z0-9-]+\.trycloudflare\.com)[[:space:]]*\|.*$#\1#p' "$work/tunnel.log" | head -n 1)"
  [[ -n "$origin" ]] && break
  sleep 1
done
[[ -n "$origin" ]] || { echo 'Cloudflare tunnel did not publish a URL' >&2; tail -40 "$work/tunnel.log" >&2; exit 1; }
url="$(node --input-type=module -e "import { v2SessionUrl } from '$script_dir/opencode-v2-api.mjs'; console.log(v2SessionUrl(process.argv[1], process.argv[2]))" "$origin" "$session")"
for _ in {1..45}; do
  code="$(curl --silent --show-error --location --max-time 10 --output "$work/page.html" --write-out '%{http_code}' "$url" || true)"
  [[ "$code" == 200 ]] && grep -qi 'opencode' "$work/page.html" && break
  sleep 2
done
[[ "${code:-}" == 200 ]] || { echo "Public V2 session link returned HTTP ${code:-none}" >&2; exit 1; }
api="$(curl --silent --show-error --location --max-time 10 -u "opencode:$OPENCODE_PASSWORD" --output /dev/null --write-out '%{http_code}' "$origin/api/info" || true)"
[[ "$api" == 200 ]] || { echo "Tunneled V2 API returned HTTP $api" >&2; exit 1; }
# A first-time browser must pair before the session renders its history.
code="$(curl --silent --show-error --max-time 10 -u "opencode:$OPENCODE_PASSWORD" -X POST \
  -H 'content-type: application/json' -d '{}' "$origin/api/pair" | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>process.stdout.write(JSON.parse(s).code||""))')"
[[ -n "$code" ]] || { echo 'Could not create a V2 pairing code' >&2; exit 1; }
pair="$origin/auth/connect/$code"
pair_code="$(curl --silent --show-error --location --max-time 10 --output /dev/null --write-out '%{http_code}' "$pair" || true)"
[[ "$pair_code" == 200 ]] || { echo "V2 pairing link returned HTTP $pair_code" >&2; exit 1; }
echo "Public session link: $url"
echo "Pairing link: $pair"
printf '%s\n' "$url" > "$work/session-url"
printf '### Public V2 session link\n\n%s\n\n- Session page: HTTP 200\n- Tunneled API: HTTP 200\n- Pairing link: HTTP 200 (expires in five minutes)\n' "$url" >> "$GITHUB_STEP_SUMMARY"
