#!/data/data/com.termux/files/usr/bin/bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
# Desktop-parity is a UI/runtime capability, not an alpha-version switch.
# Stable remains the default; opt into alpha explicitly with DSH_CHANNEL=alpha.
if [ "${DSH_CHANNEL:-stable}" = "alpha" ]; then
  exec bash "$ROOT/build-latest-termux.sh"
fi
exec bash "$ROOT/build-parity-termux.sh"
