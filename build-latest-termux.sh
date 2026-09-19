#!/data/data/com.termux/files/usr/bin/bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
export DSH_REFRESH_RUNTIME=1
export DSH_VERSION="${DSH_VERSION:-0.1.6-alpha.2}"
export DSH_NATIVE_COMPAT="${DSH_NATIVE_COMPAT:-1}"
export DSH_GIT_COMPAT="${DSH_GIT_COMPAT:-1}"
exec bash "$ROOT/build-termux.sh"
