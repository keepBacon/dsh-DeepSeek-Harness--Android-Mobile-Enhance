#!/data/data/com.termux/files/usr/bin/bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
# Historical parity alias; follows the same pinned DSH family as build-termux.sh; keep this
# alias for users of older instructions.
export DSH_REFRESH_RUNTIME=1
export DSH_VERSION="${DSH_VERSION:-0.2.1-rc.3}"
export DSH_GIT_COMPAT="${DSH_GIT_COMPAT:-1}"
exec bash "$ROOT/build-termux.sh"
