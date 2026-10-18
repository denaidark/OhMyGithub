#!/usr/bin/env bash
set -euo pipefail
: "${GITHUB_REPOSITORY:?Set GITHUB_REPOSITORY}"
: "${TRIGGER_ISSUE_NUMBER:?Set TRIGGER_ISSUE_NUMBER}"
[[ "$TRIGGER_ISSUE_NUMBER" =~ ^[1-9][0-9]*$ ]]
prefix="opencode-checkpoint-${TRIGGER_ISSUE_NUMBER}-"
releases=$(/usr/bin/time -p gh api "repos/$GITHUB_REPOSITORY/releases?per_page=100" --paginate --jq '.[].tag_name')
while IFS= read -r tag; do
  [[ "$tag" == "$prefix"* ]] || continue
  /usr/bin/time -p gh release delete "$tag" --repo "$GITHUB_REPOSITORY" --yes --cleanup-tag
done <<< "$releases"
