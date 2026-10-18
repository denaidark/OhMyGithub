#!/usr/bin/env bash
set -euo pipefail

for command in curl jq python3 git; do
  command -v "$command" >/dev/null || {
    echo "Missing required command: $command" >&2
    exit 1
  }
done

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd -- "$script_dir/.." && pwd)"
workflow_script_dir="$repo_root/.github/scripts"
tracker="$workflow_script_dir/opencode-progress-tracker.sh"
test_dir="$(mktemp -d "${TMPDIR:-/tmp}/opencode-progress-test.XXXXXX")"
port_file="$test_dir/port"
output_file="$test_dir/progress.md"
server_pid=""
git init -q "$test_dir"

cleanup() {
  if [[ -n "$server_pid" ]]; then
    kill "$server_pid" 2>/dev/null || true
    wait "$server_pid" 2>/dev/null || true
  fi
  rm -rf "$test_dir"
}
trap cleanup EXIT

python3 - "$port_file" <<'PY' >"$test_dir/server.log" 2>&1 &
import json
import pathlib
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

port_file = pathlib.Path(sys.argv[1])
sessions = [
    {"id": "ses_root", "tokens": {"input": 100}},
    {"id": "ses_child", "parentID": "ses_root", "tokens": {"output": 50}},
    {"id": "ses_nested", "parentID": "ses_child", "tokens": {"reasoning": 25}},
    {"id": "ses_done", "parentID": "ses_root", "tokens": {"cache": {"read": 10}}},
    {"id": "ses_failed", "parentID": "ses_root", "tokens": {"cache": {"write": 5}}},
]
statuses = {
    "ses_root": {"type": "busy"},
    "ses_child": {"type": "busy"},
    "ses_nested": {"type": "retry"},
    "ses_done": {"type": "idle"},
    "ses_failed": {"type": "error"},
}
messages = {
    "ses_root": [
        {"info": {"id": "msg_user_one", "role": "user", "time": {"created": 1000000000000}}, "parts": [{"type": "text", "text": "start" + "x" * 200000}]},
        {
            "info": {"role": "assistant", "parentID": "msg_user_one", "time": {"created": 1000000001000, "completed": 1000000040000}},
            "parts": [{"type": "tool", "tool": "task", "state": {"status": "running"}}],
        },
        {"info": {"id": "msg_user_two", "role": "user", "time": {"created": 1000000200000}}, "parts": [{"type": "text", "text": "continue"}]},
        {"info": {"role": "assistant", "parentID": "msg_user_two", "time": {"created": 1000000201000, "completed": 1000000210000}}, "parts": []},
        {"info": {"id": "msg_user_three", "role": "user", "time": {"created": 1000000300000}}, "parts": [{"type": "text", "text": "editor follow-up"}]},
        {"info": {"role": "assistant", "parentID": "msg_user_three", "time": {"created": 1000000301000}}, "parts": []},
    ],
    "ses_child": [
        {
            "info": {"role": "user"},
            "parts": [{"type": "file", "mime": "image/png", "url": "data:image/png;base64,AAA"}],
        },
        {"info": {"role": "assistant"}, "parts": []},
        {
            "info": {"role": "assistant"},
            "parts": [
                {
                    "type": "tool",
                    "tool": "screenshot",
                    "state": {
                        "status": "completed",
                        "attachments": [{"mime": "image/jpeg", "url": "data:image/jpeg;base64,BBB"}],
                    },
                }
            ],
        },
        {"info": {"role": "assistant"}, "parts": []},
    ],
    "ses_nested": [
        {"info": {"role": "user"}, "parts": [{"type": "text", "text": "inspect"}]},
        {
            "info": {"role": "assistant"},
            "parts": [
                {
                    "type": "tool",
                    "tool": "read",
                    "state": {
                        "status": "completed",
                        "attachments": [{"mime": "image/webp", "url": "data:image/webp;base64,CCC"}],
                    },
                }
            ],
        },
        {"info": {"role": "assistant"}, "parts": []},
    ],
    "ses_done": [
        {
            "info": {"role": "user"},
            "parts": [{"type": "file", "mime": "image/png", "url": "data:image/png;base64,DDD"}],
        },
        {"info": {"role": "assistant"}, "parts": []},
    ],
}


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == "/session":
            value = sessions[:1]  # Reproduce a truncated session list.
        elif self.path == "/session/status":
            value = statuses
        elif self.path.startswith("/session/") and self.path.endswith("/children"):
            session_id = self.path.split("/")[2]
            value = [item for item in sessions if item.get("parentID") == session_id]
        elif self.path.startswith("/session/") and self.path.endswith("/message"):
            session_id = self.path.split("/")[2]
            value = messages.get(session_id, [])
        else:
            self.send_error(404)
            return

        payload = json.dumps(value).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def log_message(self, *_):
        pass


server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
port_file.write_text(str(server.server_port))
server.serve_forever()
PY
server_pid=$!

for _ in {1..50}; do
  [[ -s "$port_file" ]] && break
  sleep 0.1
done
[[ -s "$port_file" ]] || {
  echo "Mock OpenCode server did not start" >&2
  exit 1
}

touch "$test_dir/response-comment.done"
OPENCODE_WEB_PORT="$(<"$port_file")" \
PROJECT_DIR="$test_dir" \
OPENCODE_WEB_DIR="$test_dir" \
SESSION_ID=ses_root \
REPOSITORY=AgentsLoop/PlayGround \
ISSUE_NUMBER=114 \
OMGITHUB_ORIGIN=https://omgithub.com \
PROGRESS_DRY_RUN=true \
PROGRESS_NOW_SECONDS=1000000330 \
PROGRESS_OUTPUT="$output_file" \
PROGRESS_COMMENT_TEMPLATE="$workflow_script_dir/opencode-progress-comment-template.md" \
AGENTSWEB_SSH_ENABLED=true \
AGENTSWEB_SSH_READY=true \
SSH_COMMAND='ssh -p 2222 runner@example' \
SSH_HOST=example \
SSH_PORT=2222 \
RUN_URL=http://127.0.0.1/run \
  "$tracker" || {
    echo "Tracker failed; mock server log:" >&2
    sed -n '1,120p' "$test_dir/server.log" >&2
    exit 1
  }

assert_line() {
  local expected="$1"
  if ! grep -Fq -- "$expected" "$output_file"; then
    echo "FAIL: missing '$expected'" >&2
    sed -n '1,120p' "$output_file" >&2
    exit 1
  fi
  echo "PASS: $expected"
}

assert_line "- Active subagents: 2"
assert_line "- Total subagents executed: 4"
assert_line "- Total failed subagents: 1"
assert_line "- Image-context model calls: 5"
assert_line "- Tool calls: 3"
assert_line "[Open project](https://omgithub.com/AgentsLoop/PlayGround/issues/114)"
assert_line "🔐 **Temporary AgentsWeb SSH session is ready.**"
assert_line "ssh -p 2222 runner@example"
assert_line "- Token count: 190"
assert_line "- Speed score: 2.4 tokens/s"
assert_line "- Total chat runtime: 1m"

if [[ "$("$tracker" --format-elapsed 1266)" != "21m" ]]; then
  echo "FAIL: 1266 seconds should format as 21m" >&2
  exit 1
fi
echo "PASS: 1266 seconds -> 21m"

if [[ "$("$tracker" --format-elapsed 3661)" != "1h 01m" ]]; then
  echo "FAIL: 3661 seconds should format as 1h 01m" >&2
  exit 1
fi
echo "PASS: 3661 seconds -> 1h 01m"

assert_absent() {
  local unexpected="$1"
  if grep -Fq -- "$unexpected" "$output_file"; then
    echo "FAIL: unexpected '$unexpected'" >&2
    sed -n '1,120p' "$output_file" >&2
    exit 1
  fi
  echo "PASS: absent: $unexpected"
}

assert_absent "- Session messages:"
assert_absent "- Assistant updates:"
assert_absent "- Completed tool calls:"

echo "OpenCode progress tracker local test passed."
