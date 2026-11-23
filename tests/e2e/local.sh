#!/bin/sh
# Runs the full tool suite against the local (no-cloud) server started from the built CLI.
set -e
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
TMP=$(mktemp -d)
export ACM_HOME="$TMP/home" XDG_CONFIG_HOME="$TMP/config" ACM_EXTENSION_DIR="$TMP/extension"
CLI="$ROOT/packages/cli/dist/cli.mjs"
node "$CLI" setup --local --no-install > "$TMP/setup.log"
PORT=47999
node "$CLI" serve --port $PORT > "$TMP/serve.log" 2>&1 &
PID=$!
trap 'kill $PID; rm -rf "$TMP"' EXIT
for i in $(seq 1 30); do curl -sf "http://127.0.0.1:$PORT/health" >/dev/null && break; sleep 0.2; done
ACM_SERVER="http://127.0.0.1:$PORT" node --test --test-concurrency=1 --test-timeout=240000 "$ROOT/tests/e2e/tools.test.mjs" "$ROOT/tests/e2e/private.test.mjs" "$ROOT/tests/e2e/cleanup.test.mjs"
