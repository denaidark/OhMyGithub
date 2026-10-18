#!/usr/bin/env bash
set -euo pipefail

repo="AgentsLoop/OhMyGithub"
run_id=""
key="${HOME}/.ssh/aiplay-agentsweb"
broker_url="${BROKER_REGISTRY_URL:-https://broker.agentsweb.space/api/registrations}"

usage() {
  echo "Usage: $0 <run-id> [--repo OWNER/REPO] [--key PATH]" >&2
  exit 2
}

[[ $# -ge 1 ]] || usage
run_id="$1"
shift
while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo) repo="${2:?missing repository}"; shift 2 ;;
    --key) key="${2:?missing SSH key}"; shift 2 ;;
    --broker-url) broker_url="${2:?missing broker URL}"; shift 2 ;;
    *) usage ;;
  esac
done

[[ "$run_id" =~ ^[0-9]+$ ]] || { echo "Invalid run ID: $run_id" >&2; exit 2; }
[[ -r "$key" ]] || { echo "SSH key is not readable: $key" >&2; exit 1; }
command -v gh >/dev/null || { echo "gh is required" >&2; exit 1; }
command -v jq >/dev/null || { echo "jq is required" >&2; exit 1; }

# The broker registry is faster than waiting for the workflow's issue comment.
# /api/registrations requires the broker token; without one, use the comment
# fallback below. The token is never printed.
broker_token="${BROKER_API_TOKEN:-}"
if [[ -z "$broker_token" && -f "../../sshworker/workers-dashboard/.env" ]]; then
  broker_token="$(sed -n 's/^BROKER_API_TOKEN=//p' ../../sshworker/workers-dashboard/.env | head -n 1 | tr -d '\r')"
fi

if [[ -n "$broker_token" ]]; then
  broker_json="$(curl -fsS --max-time 8 -H "Authorization: Bearer $broker_token" "$broker_url" 2>/dev/null || true)"
  ssh_data="$(jq -r --arg run "$run_id" '
    .registrations[]?
    | select((.run_id | tostring) == $run)
    | [.subdomain, (.public_port // .display_port // 22)] | @tsv
  ' <<<"$broker_json" 2>/dev/null | head -n 1)"
else
  ssh_data=""
fi

if [[ -n "$ssh_data" ]]; then
  IFS=$'\t' read -r host port <<<"$ssh_data"
  [[ "$host" == *.* ]] || host="${host}.agentsweb.space"
else
  comment_data="$(gh api "repos/${repo}/issues/comments?per_page=100")"
  ssh_data="$(jq -r --arg run "actions/runs/${run_id}" '
    .[] | select(.body | contains($run)) | .body
    | capture("ssh[^\\n]*-i [^ ]+ -p (?<port>[0-9]+) runner@(?<host>[^\\n `]+)")
    | [.host, .port] | @tsv
  ' <<<"$comment_data" | tail -n 1)"
  if [[ -n "$ssh_data" ]]; then
    IFS=$'\t' read -r host port <<<"$ssh_data"
    [[ "$host" == *.* ]] || host="${host}.agentsweb.space"
  fi
fi

if [[ -z "$ssh_data" ]]; then
  echo "No temporary SSH command found for run ${run_id}." >&2
  echo "The run may not have posted access details yet, or its session may be closed." >&2
  exit 1
fi
echo "Following live Actions log for run ${run_id} via ${host}:${port}" >&2
exec ssh -o StrictHostKeyChecking=no \
  -o UserKnownHostsFile=/dev/null \
  -o ConnectTimeout=20 \
  -i "$key" -p "$port" "runner@${host}" \
  'set -e
   diag_root=/home/runner/actions-runner/cached
   diag="$(find "$diag_root" -mindepth 3 -maxdepth 3 -type d -path "*/_diag/pages" -print | sort -V | tail -n 1)"
   [[ -n "$diag" ]] || { echo "No Actions diagnostics directory found." >&2; exit 1; }
   log="$(find "$diag" -type f -name "*_1.log" -size +0c -print -quit)"
   [[ -n "$log" ]] || { echo "No non-empty Actions page log found." >&2; exit 1; }
   echo "Following $log" >&2
   exec tail -F "$log"'
