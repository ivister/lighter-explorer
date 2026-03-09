#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

python3 -m compileall "$ROOT_DIR/backend"
osascript -l JavaScript "$ROOT_DIR/scripts/status_helpers_test.js" "$ROOT_DIR"
