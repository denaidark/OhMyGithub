#!/usr/bin/env bash
set -euo pipefail

format_elapsed() {
  local elapsed_seconds="$1"
  local elapsed_hours=$((elapsed_seconds / 3600))
  local elapsed_minutes=$(((elapsed_seconds % 3600) / 60))

  if (( elapsed_hours > 0 )); then
    printf '%dh %02dm' "$elapsed_hours" "$elapsed_minutes"
  else
    printf '%dm' "$elapsed_minutes"
  fi
}

if [[ "${1:-}" == "--format-elapsed" ]]; then
  format_elapsed "${2:?elapsed seconds are required}"
  printf '\n'
  exit 0
fi

vision_calls() {
  jq -r '
    def has_image($message):
      any((($message.parts // [])[]?);
        (.type == "file" and ((.mime // .mediaType // "") | startswith("image/"))) or
        (.type == "tool" and any(((.state.attachments // [])[]?.mime?); ((. // "") | startswith("image/"))))
      );
    reduce .[] as $message ({ seen: false, calls: 0 };
      if $message.info.role == "assistant" then
        .calls += (if .seen then 1 else 0 end)
        | .seen = (.seen or has_image($message))
      else
        .seen = (.seen or has_image($message))
      end
    ) | .calls
  '
}

while :; do
  payload="$(curl --connect-timeout 5 --max-time 15 --fail --silent --show-error \
    -H "x-opencode-directory: $PROJECT_DIR" \
    "http://127.0.0.1:$OPENCODE_WEB_PORT/session/$SESSION_ID/message" 2>/dev/null || true)"
  sessions_payload="$(curl --connect-timeout 5 --max-time 15 --fail --silent --show-error \
    -H "x-opencode-directory: $PROJECT_DIR" \
    "http://127.0.0.1:$OPENCODE_WEB_PORT/session" 2>/dev/null || true)"
  status_payload="$(curl --connect-timeout 5 --max-time 15 --fail --silent --show-error \
    -H "x-opencode-directory: $PROJECT_DIR" \
    "http://127.0.0.1:$OPENCODE_WEB_PORT/session/status" 2>/dev/null || true)"
  if jq -e 'type == "array"' >/dev/null 2>&1 <<<"$payload" && \
    jq -e 'type == "array"' >/dev/null 2>&1 <<<"$sessions_payload" && \
    jq -e 'type == "object"' >/dev/null 2>&1 <<<"$status_payload"; then
    chat_runtime_seconds="$(jq -nr \
      --slurpfile messages <(printf '%s' "$payload") \
      --argjson statuses "$status_payload" \
      --arg root "$SESSION_ID" \
      --argjson now "${PROGRESS_NOW_SECONDS:-$(date +%s)}" '
      def epoch:
        if . == null then null
        elif . > 100000000000 then . / 1000
        else .
        end;
      ($messages[0] | map(select(.info.role == "user" and .info.id and .info.time.created))) as $users
      | (($statuses[$root].type // "idle") as $state | ($state != "idle" and $state != "error" and $state != "failed")) as $busy
      | [range(0; $users | length) as $index
          | ($users[$index].info.time.created | epoch) as $started
          | (($users[$index + 1].info.time.created | epoch) // $now) as $boundary
          | ([$messages[0][] | select(.info.role == "assistant" and .info.parentID == $users[$index].info.id)
              | (.info.time.completed | epoch) // (.info.time.created | epoch)] | max) as $last
          | (if $busy and $index == (($users | length) - 1) then $now else $last end) as $finished
          | select($started != null and $finished != null and $finished > $started)
          | (([$finished, $boundary] | min) - $started)
        ]
      | (add // 0 | floor)
    ')"
    # The list endpoint is capped and may omit children; walk the explicit child relation.
    pending_ids=("$SESSION_ID")
    seen_ids=("$SESSION_ID")
    while (( ${#pending_ids[@]} )); do
      parent_id="${pending_ids[0]}"
      pending_ids=("${pending_ids[@]:1}")
      children_payload="$(curl --connect-timeout 5 --max-time 15 --fail --silent --show-error \
        -H "x-opencode-directory: $PROJECT_DIR" \
        "http://127.0.0.1:$OPENCODE_WEB_PORT/session/$parent_id/children" 2>/dev/null || true)"
      if jq -e 'type == "array"' >/dev/null 2>&1 <<<"$children_payload"; then
        while IFS= read -r child_id; do
          [[ -n "$child_id" ]] || continue
          if [[ " ${seen_ids[*]} " != *" $child_id "* ]]; then
            seen_ids+=("$child_id")
            pending_ids+=("$child_id")
          fi
        done < <(jq -r '.[].id' <<<"$children_payload")
        sessions_payload="$(jq -cn --slurpfile all <(printf '%s' "$sessions_payload") --slurpfile children <(printf '%s' "$children_payload") '$all[0] + $children[0] | unique_by(.id)')"
      fi
    done
    subagent_stats="$(jq -nr \
      --arg root "$SESSION_ID" \
      --slurpfile sessions <(printf '%s' "$sessions_payload") \
      --argjson statuses "$status_payload" '
      def descendants($all; $parent):
        [$all[] | select(.parentID == $parent)] as $children
        | ($children | map(.id)) as $ids
        | if ($ids | length) == 0 then $ids
          else $ids + ([$ids[] | descendants($all; .)] | add)
          end;
      ($sessions[0] | descendants($sessions[0]; $root)) as $subagents
      | {
          total: ($subagents | length),
          failed: ([$statuses | to_entries[]
            | select((.key as $id | ($subagents | index($id))) != null)
            | select(.value.type == "error" or .value.type == "failed")
          ] | length),
          active: ([$statuses | to_entries[]
            | select((.key as $id | ($subagents | index($id))) != null)
            | select(.value.type != "idle" and .value.type != "error" and .value.type != "failed")
          ] | length)
        }
      | [.active, .total, .failed] | @tsv
    ')"
    IFS=$'\t' read -r active_subagents total_subagents failed_subagents <<<"$subagent_stats"
    token_count="$(jq -nr \
      --arg root "$SESSION_ID" \
      --slurpfile sessions <(printf '%s' "$sessions_payload") '
      def descendants($all; $parent):
        [$all[] | select(.parentID == $parent)] as $children
        | ($children | map(.id)) as $ids
        | if ($ids | length) == 0 then $ids
          else $ids + ([$ids[] | descendants($all; .)] | add)
          end;
      ([$root] + ($sessions[0] | descendants($sessions[0]; $root))) as $tracked
      | reduce $sessions[0][] as $session (0;
          if ($tracked | index($session.id)) == null then .
          else .
            + ($session.tokens.input // 0)
            + ($session.tokens.output // 0)
            + ($session.tokens.reasoning // 0)
            + ($session.tokens.cache.read // 0)
            + ($session.tokens.cache.write // 0)
          end
        )
    ')"
    subagent_ids="$(jq -nr \
      --arg root "$SESSION_ID" \
      --slurpfile sessions <(printf '%s' "$sessions_payload") '
      def descendants($all; $parent):
        [$all[] | select(.parentID == $parent)] as $children
        | ($children | map(.id)) as $ids
        | if ($ids | length) == 0 then $ids
          else $ids + ([$ids[] | descendants($all; .)] | add)
          end;
      ($sessions[0] | descendants($sessions[0]; $root))[]
    ')"
    vision_count="$(vision_calls <<<"$payload")"
    stats="$(jq -r '[.[].parts[]? | select(.type == "tool")] | [length, ([.[] | select(.state.status == "running" or .state.status == "pending")] | length)] | @tsv' <<<"$payload")"
    IFS=$'\t' read -r tool_count active_count <<<"$stats"
    while IFS= read -r subagent_id; do
      [[ -n "$subagent_id" ]] || continue
      subagent_payload="$(curl --connect-timeout 5 --max-time 15 --fail --silent --show-error \
        -H "x-opencode-directory: $PROJECT_DIR" \
        "http://127.0.0.1:$OPENCODE_WEB_PORT/session/$subagent_id/message" 2>/dev/null || true)"
      if jq -e 'type == "array"' >/dev/null 2>&1 <<<"$subagent_payload"; then
        subagent_vision_count="$(vision_calls <<<"$subagent_payload")"
        vision_count=$((vision_count + subagent_vision_count))
        subagent_tools="$(jq -r '[.[].parts[]? | select(.type == "tool")] | [length, ([.[] | select(.state.status == "running" or .state.status == "pending")] | length)] | @tsv' <<<"$subagent_payload")"
        IFS=$'\t' read -r child_tools child_active <<<"$subagent_tools"
        tool_count=$((tool_count + child_tools))
        active_count=$((active_count + child_active))
      fi
    done <<<"$subagent_ids"
    changed_count="$(git -C "$PROJECT_DIR" status --porcelain 2>/dev/null | wc -l | tr -d ' ')"
    chat_runtime="$(format_elapsed "$chat_runtime_seconds")"
    speed_score="$(awk -v tokens="$token_count" -v elapsed="$chat_runtime_seconds" \
      'BEGIN { if (elapsed > 0) printf "%.1f", tokens / elapsed; else print "0.0" }')"
    access_links="$(< "${PROGRESS_COMMENT_TEMPLATE:-$(dirname "$0")/opencode-progress-comment-template.md}")"
    ssh_section=""
    if [[ "${AGENTSWEB_SSH_ENABLED:-false}" == "true" && "${AGENTSWEB_SSH_READY:-false}" == "true" ]]; then
      ssh_section="🔐 **Temporary AgentsWeb SSH session is ready.**

Run: ${RUN_URL}
Host: ${SSH_HOST}:${SSH_PORT}

Run this command while the job is active:

Command:
${SSH_COMMAND}
"
    fi
    progress_stats="- Total chat runtime: ${chat_runtime}
- Token count: ${token_count}
- Speed score: ${speed_score} tokens/s
- Tool calls: $tool_count
- Active tool calls: $active_count
- Active subagents: $active_subagents
- Total subagents executed: $total_subagents
- Total failed subagents: $failed_subagents
- Image-context model calls: $vision_count
- Changed workspace files: $changed_count"
    project_url="${OMGITHUB_ORIGIN:-https://omgithub.com}"
    project_url="${project_url%/}/${REPOSITORY}/issues/${ISSUE_NUMBER}"
    access_note="Open the project to access chat, live files, previews, and progress."
    access_links="${access_links//@SSH_SECTION@/$ssh_section}"
    access_links="${access_links//@UPDATED@/$(date -u '+%Y-%m-%d %H:%M:%S UTC')}"
    access_links="${access_links//@PROJECT_URL@/$project_url}"
    access_links="${access_links//@PROGRESS_STATS@/$progress_stats}"
    access_links="${access_links//@ACCESS_NOTE@/$access_note}"
    body="${access_links}"
    if [[ "${PROGRESS_DRY_RUN:-false}" == "true" ]]; then
      printf '%s\n' "$body" > "${PROGRESS_OUTPUT:?PROGRESS_OUTPUT is required in dry-run mode}"
    else
      rate_json='null'
      if [[ -s "${OPENCODE_WEB_DIR}/github-rate.json" ]] && jq -e 'type == "object"' "${OPENCODE_WEB_DIR}/github-rate.json" >/dev/null 2>&1; then
        rate_json="$(<"${OPENCODE_WEB_DIR}/github-rate.json")"
      fi
      report="$(jq -n \
        --arg run "$GITHUB_RUN_ID" --argjson attempt "${GITHUB_RUN_ATTEMPT:-1}" \
        --arg observed_at "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" \
        --argjson chat_runtime_seconds "$chat_runtime_seconds" --argjson model_tokens "$token_count" \
        --argjson tool_calls "$tool_count" --argjson active_tool_calls "$active_count" \
        --argjson active_subagents "$active_subagents" --argjson total_subagents "$total_subagents" \
        --argjson failed_subagents "$failed_subagents" --argjson image_calls "$vision_count" \
        --argjson changed_files "$changed_count" --argjson rate "$rate_json" \
        '{run:$run,attempt:$attempt,observed_at:$observed_at,stats:{chat_runtime_seconds:$chat_runtime_seconds,model_tokens:$model_tokens,tool_calls:$tool_calls,active_tool_calls:$active_tool_calls,active_subagents:$active_subagents,total_subagents:$total_subagents,failed_subagents:$failed_subagents,image_calls:$image_calls,changed_files:$changed_files},rate:$rate}')"
      /usr/bin/time -p curl --connect-timeout 5 --max-time 15 --fail --silent --show-error \
        -H "Authorization: Bearer ${OMGITHUB_CALLBACK_TOKEN:-}" -H 'Content-Type: application/json' \
        --data "$report" "${OMGITHUB_ORIGIN:-https://omgithub.com}/api/github/$REPOSITORY/issues/$ISSUE_NUMBER/telemetry" >/dev/null || true
    fi
  fi
  [[ -f "$OPENCODE_WEB_DIR/response-comment.done" ]] && break
  sleep 10
done
