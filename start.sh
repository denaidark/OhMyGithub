#!/usr/bin/env bash
# Build the static game into ./dist and serve it in the foreground on $PORT.
set -euo pipefail
umask 022

PROJECT_DIR="${PROJECT_DIR:-/home/runner/work/OhMyGithub/OhMyGithub}"
PORT="${PORT:-3000}"
OPENCODE_WEB_DIR="${OPENCODE_WEB_DIR:-$PROJECT_DIR/.omgithub-runtime}"

SOURCE_DIR="$PROJECT_DIR/named-tunnel-transport-test"
BUILD_DIR="$PROJECT_DIR/dist"

export PROJECT_DIR PORT

cd "$PROJECT_DIR"

/usr/bin/time -p test -f "$SOURCE_DIR/index.html"
/usr/bin/time -p mkdir -p "$BUILD_DIR" "$OPENCODE_WEB_DIR"

# Static build: copy the source game into the project-owned dist directory.
/usr/bin/time -p rm -rf "$BUILD_DIR"
/usr/bin/time -p mkdir -p "$BUILD_DIR"
/usr/bin/time -p cp -R "$SOURCE_DIR/." "$BUILD_DIR/"
/usr/bin/time -p test -f "$BUILD_DIR/index.html"

# Worker metadata only; the served directory stays inside PROJECT_DIR.
/usr/bin/time -p node -e '
const fs = require("node:fs");
const [file, project, directory] = process.argv.slice(1);
fs.writeFileSync(file, JSON.stringify({ project, directory }) + "\n");
' "$OPENCODE_WEB_DIR/deployment-output.json" "$PROJECT_DIR" "$BUILD_DIR"
/usr/bin/time -p cat "$OPENCODE_WEB_DIR/deployment-output.json"

# Foreground server; the controller owns restarting this process.
/usr/bin/time -p node "$PROJECT_DIR/scripts/serve-static.mjs" "$BUILD_DIR" "$PORT"
