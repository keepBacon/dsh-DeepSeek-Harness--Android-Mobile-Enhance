#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
EM="$ROOT/app/src/main/java/com/dshmobile/shell/EngineManager.kt"
ES="$ROOT/app/src/main/java/com/dshmobile/shell/EngineService.kt"
MA="$ROOT/app/src/main/java/com/dshmobile/shell/MainActivity.kt"
UM="$ROOT/app/src/main/java/com/dshmobile/shell/UpdateManager.kt"
BT="$ROOT/build-termux.sh"
RP="$ROOT/scripts/android-runtime-patch.mjs"

must() { grep -Fq "$2" "$1" || { echo "[FAIL] missing: $2"; exit 1; }; }
forbid() { ! grep -Fq "$2" "$1" || { echo "[FAIL] forbidden pattern remains: $2"; exit 1; }; }

must "$MA" 'onPickRequest = { callbackId -> runOnUiThread'
must "$MA" 'onNotify = { title, text -> runOnUiThread'
must "$ES" 'EngineManager.isMaintenanceMode()'
must "$EM" 'process.destroyForcibly()'
must "$EM" 'process.waitFor(graceMillis, TimeUnit.MILLISECONDS)'
must "$EM" 'relocateDirTransactional'
must "$EM" 'migration-backup-'
must "$EM" 'fun smokeTestRuntime'
must "$EM" 'fun beginMaintenance()'
must "$UM" 'EngineManager.beginMaintenance()'
must "$UM" 'engine.stopEngine()'
must "$UM" 'engine.smokeTestRuntime()'
must "$UM" '.put("kind", "ota")'
must "$BT" 'repack_snapshot_stage'
must "$BT" 'koffi Android prebuilt/native load: OK'
must "$BT" 'koffi Android source build/load failed'
forbid "$BT" 'koffi build returned success but no .node addon was produced'
forbid "$BT" 'else built_koffi=1'
must "$RP" 'mandatory: androidFlockMandatory'
must "$RP" 'mandatory: androidStableStorageMandatory'
must "$RP" 'requiredIfPresent: androidStableStorageMandatory'

echo '[OK] high-severity static regression checks passed'
