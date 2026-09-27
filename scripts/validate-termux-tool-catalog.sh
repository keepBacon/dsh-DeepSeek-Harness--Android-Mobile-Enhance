#!/usr/bin/env bash
set -Eeuo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
. "$ROOT/scripts/dsh-termux-tool-catalog.sh"
dsh_tool_catalog_self_test
echo "[DSH] Tool catalog static validation: OK"
