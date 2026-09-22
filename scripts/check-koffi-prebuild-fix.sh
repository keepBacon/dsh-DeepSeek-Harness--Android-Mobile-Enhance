#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BT="$ROOT/build-termux.sh"
BG="$ROOT/app/build.gradle.kts"
MA="$ROOT/app/src/main/java/com/dshmobile/shell/MainActivity.kt"

must() { grep -Fq "$2" "$1" || { echo "[FAIL] missing: $2"; exit 1; }; }
forbid() { ! grep -Fq "$2" "$1" || { echo "[FAIL] forbidden pattern remains: $2"; exit 1; }; }

must "$BT" '@koromix/koffi-android-arm64'
must "$BT" 'koffi Android prebuilt/native load: OK'
must "$BT" 'Koffi prebuilt is not loadable; building from source for API 30'
must "$BT" 'koffi loaded without a native .node entry in require.cache'
must "$BT" 'CFLAGS="$flags" CXXFLAGS="$flags"'
forbid "$BT" 'koffi build returned success but no .node addon was produced'
must "$BG" 'versionName = "0.1.1"'
must "$BG" 'versionCode = 35'
must "$MA" 'DSH-Android/0.1.1'

echo '[OK] Koffi Android prebuilt/source fallback regression checks passed'
