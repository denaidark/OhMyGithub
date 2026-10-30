#!/usr/bin/env bash
set -euo pipefail

timed() { local start=$SECONDS; "$@"; local rc=$?; printf '[timing] %s: %ss\n' "$1" "$((SECONDS-start))" >&2; return "$rc"; }
work="$RUNNER_TEMP/omgithub-v2"
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
timed mkdir -p "$work/home" "$work/config" "$work/data" "$work/cache" "$work/restore-home" "$work/restore-data" "$work/restore-config" "$work/restore-cache"
export HOME="$work/home" XDG_CONFIG_HOME="$work/config" XDG_DATA_HOME="$work/data" XDG_CACHE_HOME="$work/cache"
OPENCODE_PASSWORD="$(openssl rand -hex 24)"
export OPENCODE_PASSWORD
echo "::add-mask::$OPENCODE_PASSWORD"
printf '{"plugin":[],"permission":{"*":"allow","task":"allow"}}\n' > "$work/config.json"
export OPENCODE_CONFIG="$work/config.json"
timed curl --fail --silent --show-error --location --retry 3 --max-time 45 https://opencode.ai/v2/install -o "$work/install.sh"
timed bash "$work/install.sh" --version "$OPENCODE_V2_VERSION" --no-modify-path
bin="$HOME/.opencode/bin/opencode"
version="$($bin --version)"
[[ "$version" == "opencode v$OPENCODE_V2_VERSION" ]] || { echo "Unexpected OpenCode version: $version" >&2; exit 1; }
echo "OpenCode version: $version"
port=4096
"$bin" serve --hostname 127.0.0.1 --port "$port" > "$work/server.log" 2>&1 &
echo "$!" > "$work/server.pid"
for _ in {1..60}; do
  if curl --silent --fail --max-time 2 -u "opencode:$OPENCODE_PASSWORD" "http://127.0.0.1:$port/api/info" > "$work/info.json"; then break; fi
  kill -0 "$(cat "$work/server.pid")" || { sed -n '1,100p' "$work/server.log"; exit 1; }
  sleep 1
done
timed node -e 'const i=require(process.argv[1]);if(i.version!==process.argv[2])throw Error("Unexpected server version");console.log("V2 server is healthy:",i.version)' "$work/info.json" "$OPENCODE_V2_VERSION"
# shellcheck disable=SC2016
model="$(node --input-type=module -e '
const preferred=["deepseek-v4.1-flash-free","glm-5.3-flash-free","mimo-v2.6-flash-free","big-pickle"];
try {const r=await fetch("https://models.opencode.ai/api.json",{signal:AbortSignal.timeout(15000)});if(!r.ok)throw Error(`HTTP ${r.status}`);const c=await r.json();const m=c.opencode?.models||{};const id=preferred.find(id=>m[id]&&m[id].status!=="deprecated"&&m[id].tool_call===true&&m[id].cost?.input===0&&m[id].cost?.output===0);console.log(`opencode/${id||preferred[0]}`)}catch{console.log(`opencode/${preferred[0]}`)}')"
echo "Selected model: $model"
prompt='Create v2-test-result.txt containing exactly ACTIONS_V2_OK. Do not use git. Reply DONE when finished.'
timed "$bin" run --server "http://127.0.0.1:$port" --auto --model "$model" --format json "$prompt" > "$work/run.jsonl"
[[ "$(cat v2-test-result.txt)" == ACTIONS_V2_OK ]] || { echo 'Model did not create the expected test file' >&2; exit 1; }
session="$(node -e 'const fs=require("fs");for(const s of fs.readFileSync(process.argv[1],"utf8").split("\n")){try{const x=JSON.parse(s);if(x.sessionID){console.log(x.sessionID);break}}catch{}}' "$work/run.jsonl")"
[[ "$session" == ses_* ]] || { echo 'Missing session ID' >&2; exit 1; }
echo "Session: $session"
timed "$bin" run --server "http://127.0.0.1:$port" --session "$session" --auto --model "$model" --format json 'What exact text did you write to the file? Reply with only that text. Do not use tools.' > "$work/follow.jsonl"
node -e 'const fs=require("fs");const a=fs.readFileSync(process.argv[1],"utf8").split("\n").flatMap(s=>{try{return [JSON.parse(s)]}catch{return []}});if(!a.some(x=>x.type==="text"&&x.part?.text?.includes("ACTIONS_V2_OK")))throw Error("Follow-up did not retain the conversation");console.log("Follow-up retained conversation")' "$work/follow.jsonl"
timed node "$script_dir/v2-experiment-api.mjs" "$session" "$work/fork-id"
fork="$(cat "$work/fork-id")"
timed "$bin" run --server "http://127.0.0.1:$port" --session "$fork" --auto --model "$model" --format json 'Read v2-test-result.txt and reply exactly VALIDATED if it contains ACTIONS_V2_OK.' > "$work/fork-run.jsonl"
node -e 'const fs=require("fs");const a=fs.readFileSync(process.argv[1],"utf8").split("\n").flatMap(s=>{try{return [JSON.parse(s)]}catch{return []}});if(!a.some(x=>x.type==="text"&&x.part?.text?.includes("VALIDATED")))throw Error("V2 fork validation did not succeed");console.log("V2 fork validation passed")' "$work/fork-run.jsonl"
timed "$bin" session export "$session" --server "http://127.0.0.1:$port" > "$work/export.json"
export HOME="$work/restore-home" XDG_CONFIG_HOME="$work/restore-config" XDG_DATA_HOME="$work/restore-data" XDG_CACHE_HOME="$work/restore-cache"
timed "$bin" session import "$work/export.json" --standalone --directory "$PWD"
timed "$bin" session export "$session" --standalone > "$work/restored.json"
node -e 'const fs=require("fs");const a=JSON.parse(fs.readFileSync(process.argv[1])),b=JSON.parse(fs.readFileSync(process.argv[2]));if(a.info.id!==b.info.id||JSON.stringify(a.messages)!==JSON.stringify(b.messages))throw Error("Checkpoint round trip changed the conversation");console.log("Checkpoint round trip passed:",a.messages.length,"messages")' "$work/export.json" "$work/restored.json"
timed "$bin" run --standalone --session "$session" --auto --model "$model" --format json 'What exact text did you write to the file earlier? Reply with only that text. Do not use tools.' > "$work/restored-follow.jsonl"
node -e 'const fs=require("fs");const a=fs.readFileSync(process.argv[1],"utf8").split("\n").flatMap(s=>{try{return [JSON.parse(s)]}catch{return []}});if(!a.some(x=>x.type==="text"&&x.part?.text?.includes("ACTIONS_V2_OK")))throw Error("Restored session did not retain the conversation");console.log("Restored follow-up retained conversation")' "$work/restored-follow.jsonl"
printf '### OpenCode V2 test\n\n- Version: %s\n- Model: %s\n- Session: %s\n- File creation, API events, fork validation, checkpoint round trip and restored follow-up passed.\n' "$version" "$model" "$session" >> "$GITHUB_STEP_SUMMARY"
