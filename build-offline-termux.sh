#!/data/data/com.termux/files/usr/bin/bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
# Keep the proven Android runtime extracted from the base APK; useful when npm
# is unavailable or when bisecting a newest-DSH regression.
export DSH_REFRESH_RUNTIME=0
export DSH_GIT_COMPAT=0
exec bash "$ROOT/build-termux.sh"
