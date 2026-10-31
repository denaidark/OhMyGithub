#!/usr/bin/env bash
# Capture desktop + mobile evidence for the running preview.
set -euo pipefail

cd "$(dirname "$0")"

: "${CAPTURE_URL:?Set CAPTURE_URL to the exact preview URL}"
: "${CAPTURE_DIR:?Set CAPTURE_DIR to an evidence directory}"

PROJECT_DIR="${PROJECT_DIR:-$(pwd)}"

# Evidence must never land inside the served source tree.
/usr/bin/time -p bash -c '
project="$(realpath -m "$1")"
target="$(realpath -m "$2")"
case "$target/" in
  "$project"/*) echo "CAPTURE_DIR must be outside PROJECT_DIR: $target" >&2; exit 1 ;;
esac
' _ "$PROJECT_DIR" "$CAPTURE_DIR"

/usr/bin/time -p mkdir -p "$CAPTURE_DIR"
/usr/bin/time -p test -d "$CAPTURE_DIR"

/usr/bin/time -p node "$(pwd)/scripts/capture-preview.mjs"
