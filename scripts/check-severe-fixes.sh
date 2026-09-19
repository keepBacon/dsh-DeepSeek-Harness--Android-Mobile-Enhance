#!/data/data/com.termux/files/usr/bin/bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

fail() { echo "[FAIL] $*" >&2; exit 1; }
ok() { echo "[OK] $*"; }

grep -q 'android:usesCleartextTraffic="false"' app/src/main/AndroidManifest.xml || fail "global cleartext traffic is not disabled"
grep -q 'networkSecurityConfig="@xml/network_security_config"' app/src/main/AndroidManifest.xml || fail "network security config missing"
! grep -Rqs 'http://10\.0\.2\.2:8899' app/src/main/java || fail "insecure emulator update endpoint still present"
grep -q 'snapshot path escapes destination' app/src/main/java/com/dshmobile/shell/SnapshotExtractor.kt || fail "snapshot traversal guard missing"
grep -q 'snapshot symlink escapes destination' app/src/main/java/com/dshmobile/shell/SnapshotExtractor.kt || fail "snapshot symlink guard missing"
grep -q 'snapshot symlink uses untrusted absolute target' app/src/main/java/com/dshmobile/shell/SnapshotExtractor.kt || fail "absolute symlink allowlist guard missing"
grep -q 'Paths.get("/system/bin/sh").normalize()' app/src/main/java/com/dshmobile/shell/SnapshotExtractor.kt || fail "Android system shell compatibility allowlist missing"
grep -q 'AUTH_CHALLENGE' app/src/main/java/com/dshmobile/shell/EngineProbe.kt || fail "DSH identity probe missing"
grep -q 'expectedCapability' app/src/main/java/com/dshmobile/shell/AndroidBridge.kt || fail "bridge capability gate missing"
grep -q 'BRIDGE_CAP' app/src/main/java/com/dshmobile/shell/MainActivity.kt || fail "main-frame bridge capability injection missing"
grep -q 'Signature.getInstance("Ed25519")' app/src/main/java/com/dshmobile/shell/UpdateManager.kt || fail "runtime update signature verification missing"
grep -q 'MAX_UPDATE_BYTES' app/src/main/java/com/dshmobile/shell/UpdateManager.kt || fail "runtime update size cap missing"
for f in build*.sh; do bash -n "$f"; done
node --check scripts/android-runtime-patch.mjs >/dev/null
ok "severe-fix static checks passed"
