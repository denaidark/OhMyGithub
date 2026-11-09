#!/usr/bin/env bash
# Start Fusion Gateway before OpenCode serve.
# Configures gateway to proxy plugin requests with credential injection.
#
# Usage: start-fusion-gateway.sh <run-dir>
#
# Creates:
# - fusion-gateway.pid
# - fusion-token (0600, generation token for plugin)
# - fusion-control.sock (control socket)
# - fusion-gateway.env (exports for serve)
#
# Environment:
# - FUSION_ENABLED: 'true' to enable gateway (default: auto-detect from plugin_commit)
# - OMGITHUB_ORIGIN: OmGithub API origin for lease acquisition
# - FUSION_SHARED_UPSTREAMS: Comma-separated allowed shared upstream hosts

set -euo pipefail

RUN_DIR="${1:?Usage: start-fusion-gateway.sh <run-dir>}"
mkdir -p "$RUN_DIR"

LOG_FILE="$RUN_DIR/fusion-gateway.log"
TOKEN_FILE="$RUN_DIR/fusion-token"
SOCKET_PATH="$RUN_DIR/fusion-control.sock"
PID_FILE="$RUN_DIR/fusion-gateway.pid"
ENV_FILE="$RUN_DIR/fusion-gateway.env"

log() { echo "$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ) $*" | tee -a "$LOG_FILE"; }

log "[start-fusion-gateway] Starting gateway in $RUN_DIR"

# Initialize generation token file (0600 permissions)
# Plugin reads this to authenticate with gateway
GENERATION_TOKEN="$(openssl rand -hex 32)"
printf '%s' "$GENERATION_TOKEN" > "$TOKEN_FILE"
chmod 0600 "$TOKEN_FILE"
log "[start-fusion-gateway] Generation token initialized (0600)"

# Clean up any existing socket
rm -f "$SOCKET_PATH"

# Start gateway as background Node process
nohup node "$(dirname "$0")/fusion-gateway-serve.mjs" \
  --run-dir "$RUN_DIR" \
  --token-file "$TOKEN_FILE" \
  --socket-path "$SOCKET_PATH" \
  --shared-upstreams "${FUSION_SHARED_UPSTREAMS:-}" \
  >> "$LOG_FILE" 2>&1 &

GATEWAY_PID=$!
echo "$GATEWAY_PID" > "$PID_FILE"
log "[start-fusion-gateway] Gateway started (PID=$GATEWAY_PID)"

# Wait for gateway to be ready (socket exists)
for _ in $(seq 1 30); do
  if [[ -S "$SOCKET_PATH" ]]; then
    log "[start-fusion-gateway] Gateway ready (socket available)"
    break
  fi
  sleep 0.2
done

if [[ ! -S "$SOCKET_PATH" ]]; then
  log "[start-fusion-gateway] ERROR: Gateway socket not available after 6s"
  cat "$LOG_FILE" >&2
  exit 1
fi

# Get actual port from gateway
GATEWAY_PORT="$(node -e "
const net = require('net');
const client = net.createConnection('$SOCKET_PATH');
client.write(JSON.stringify({ action: 'status' }) + '\n');
client.on('data', d => { 
  const r = JSON.parse(d.toString());
  console.log(r.port || '');
  client.end();
});
client.on('error', () => process.exit(1));
" 2>/dev/null || echo "")"

if [[ -z "$GATEWAY_PORT" ]]; then
  log "[start-fusion-gateway] ERROR: Could not get gateway port"
  exit 1
fi

log "[start-fusion-gateway] Gateway listening on port $GATEWAY_PORT"

# Write environment exports for serve
# FUSION_UPSTREAM: Plugin connects here (loopback)
# FUSION_TOKEN_FILE: Plugin reads generation token
# Unset raw FUSION_ACCESS_TOKEN so serve/tools don't get it directly
cat > "$ENV_FILE" <<EOF
export FUSION_UPSTREAM="http://127.0.0.1:$GATEWAY_PORT"
export FUSION_TOKEN_FILE="$TOKEN_FILE"
export FUSION_CONTROL_SOCKET="$SOCKET_PATH"
export FUSION_GATEWAY_PID="$GATEWAY_PID"
unset FUSION_ACCESS_TOKEN
unset FUSION_SHARED_TOKEN
EOF

log "[start-fusion-gateway] Environment written to $ENV_FILE"
log "[start-fusion-gateway] Complete"

echo "GATEWAY_PORT=$GATEWAY_PORT"
