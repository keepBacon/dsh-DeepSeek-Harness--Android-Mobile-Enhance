#!/data/data/com.termux/files/usr/bin/bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
# npm `latest`/`next` channel pinned on 2026-09-19.
export DSH_REFRESH_RUNTIME=1
export DSH_VERSION="${DSH_VERSION:-0.1.5-rc.2}"
export DSH_NATIVE_COMPAT="${DSH_NATIVE_COMPAT:-1}"
export DSH_GIT_COMPAT="${DSH_GIT_COMPAT:-1}"
exec bash "$ROOT/build-termux.sh"
