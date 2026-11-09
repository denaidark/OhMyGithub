#!/usr/bin/env bash
# Dead proxy mid-build (tunnels refused, e.g. WARP connection issues): restart
# `opencode serve` on the fallback (if any), or on the runner network when there is none.
# Records warp.proxy_drop for admin stats. No secrets here.
# DataImpulse/residential proxy removed per t256 authorization.
set -uo pipefail
set +x
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
: "${OPENCODE_BIN:?}" "${OPENCODE_WEB_DIR:?}"
current="$(cat "$OPENCODE_WEB_DIR/opencode-proxy" 2>/dev/null || true)"
fallback="$(cat "$OPENCODE_WEB_DIR/opencode-proxy.fallback" 2>/dev/null || true)"
[[ "$fallback" == http://127.0.0.1:* && "$fallback" != "$current" ]] || fallback=''
reason="$(node -p 'const e=String(require(process.argv[1]).last_error||"");/TRAFFIC_EXHAUSTED/i.test(e)?"traffic_exhausted":"tunnel_error"' "$OPENCODE_WEB_DIR/proxy-bytes.json" 2>/dev/null || echo tunnel_error)"
echo "[proxy] dropping the proxy ($reason); OpenCode now uses ${fallback:+the WARP relay}${fallback:-the runner network}" >&2
rm -f "$OPENCODE_WEB_DIR/opencode-proxy.fallback"
bash "$here/start-opencode-serve.sh" "$fallback" --wait || exit 1
PROXY_DROP="$reason" node -e 'const fs=require("fs"),f=process.env.OPENCODE_WEB_DIR+"/warp-status.json";let s={};try{s=JSON.parse(fs.readFileSync(f,"utf8"))}catch{}
fs.writeFileSync(f,JSON.stringify({...s,proxy_drop:process.env.PROXY_DROP}))' 2>/dev/null || true
