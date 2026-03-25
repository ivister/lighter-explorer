#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

python3 -m compileall "$ROOT_DIR/backend"
osascript -l JavaScript "$ROOT_DIR/scripts/status_helpers_test.js" "$ROOT_DIR"
osascript -l JavaScript "$ROOT_DIR/scripts/traffic_saver_test.js" "$ROOT_DIR"
osascript -l JavaScript "$ROOT_DIR/scripts/ws_lifecycle_test.js" "$ROOT_DIR"
