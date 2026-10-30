#!/usr/bin/env bash
set -euo pipefail

timed() { local start=$SECONDS; "$@"; local rc=$?; printf '[timing] %s: %ss\n' "$1" "$((SECONDS-start))" >&2; return "$rc"; }
dir="$RUNNER_TEMP/omgithub-v2-ssh"
timed mkdir -p "$dir" "$HOME/.ssh"
timed chmod 700 "$dir" "$HOME/.ssh"
if [[ "$RUNNER_OS" == Linux ]]; then
  timed sudo apt-get update -qq
  timed sudo apt-get install -y -qq openssh-server
  timed sudo mkdir -p /run/sshd
fi
timed ssh-keygen -t ed25519 -f "$dir/verify-key" -N '' -q
{ cat "$dir/verify-key.pub"; printf '%s\n' "$AGENTSWEB_SSH_PUBLIC_KEY"; } > "$HOME/.ssh/authorized_keys"
timed chmod 600 "$HOME/.ssh/authorized_keys"
# shellcheck disable=SC2024
sudo /usr/sbin/sshd -D -e -p 2222 -o PasswordAuthentication=no -o PermitRootLogin=no -o PubkeyAuthentication=yes > "$dir/sshd.log" 2>&1 &
echo "$!" > "$dir/sshd.pid"
for _ in {1..60}; do
  nc -z -w 1 127.0.0.1 2222 >/dev/null 2>&1 && break
  kill -0 "$(cat "$dir/sshd.pid")" || { cat "$dir/sshd.log"; exit 1; }
  sleep 1
done
timed nc -z -w 1 127.0.0.1 2222
timed git clone --depth 1 --filter=blob:none --sparse https://github.com/denaidark/agent-workspace.git "$dir/agent-workspace"
timed git -C "$dir/agent-workspace" sparse-checkout set lolgames_tunnel
port=$((32000 + GITHUB_RUN_ID % 1000))
nohup env PYTHONPATH="$dir/agent-workspace" python3 -m lolgames_tunnel client 127.0.0.1:2222 --server agentsweb.space --name "opencode-v2-${GITHUB_RUN_ID}-ssh" --public-port "$port" > "$dir/tunnel.log" 2>&1 &
echo "$!" > "$dir/tunnel.pid"
for _ in {1..60}; do
  grep -q '^ssh://' "$dir/tunnel.log" && break
  kill -0 "$(cat "$dir/tunnel.pid")" || { cat "$dir/tunnel.log"; exit 1; }
  sleep 1
done
endpoint="$(sed -nE 's#^ssh://([^:[:space:]]+):([0-9]+).*$#\1 \2#p' "$dir/tunnel.log" | head -n 1)"
[[ -n "$endpoint" ]] || { cat "$dir/tunnel.log"; exit 1; }
read -r host public_port <<< "$endpoint"
for _ in {1..12}; do
  if ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o BatchMode=yes -o ConnectTimeout=10 -i "$dir/verify-key" -p "$public_port" "runner@$host" true; then verified=1; break; fi
  sleep 5
done
[[ "${verified:-}" == 1 ]] || { echo 'SSH verification failed' >&2; exit 1; }
command="ssh -i ~/.ssh/aiplay-agentsweb -p $public_port runner@$host"
printf '%s\n' "$command" > "$dir/command"
# shellcheck disable=SC2016
printf '### Temporary SSH\n\nRun: %s/%s/actions/runs/%s\n\n```sh\n%s\n```\n' "$GITHUB_SERVER_URL" "$GITHUB_REPOSITORY" "$GITHUB_RUN_ID" "$command" >> "$GITHUB_STEP_SUMMARY"
if [[ -n "${ISSUE_NUMBER:-}" ]]; then
  body="Temporary V2 test SSH for $GITHUB_SERVER_URL/$GITHUB_REPOSITORY/actions/runs/$GITHUB_RUN_ID

\`$command\`"
  timed gh api "repos/$GITHUB_REPOSITORY/issues/$ISSUE_NUMBER/comments" --method POST -f "body=$body" >/dev/null
fi
