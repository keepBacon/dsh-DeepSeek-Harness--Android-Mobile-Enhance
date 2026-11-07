#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
PREFIX="$TMP/data/usr"
WORK="$TMP/workspace"
mkdir -p "$PREFIX/libexec/dsh-mobile" "$WORK" "$TMP/home/tmp"
cp "$ROOT/scripts/dsh-android-sandbox-runner.sh" "$TMP/runner.sh"
# Linux CI has no /system/bin/sh. Only mock this copy, never the APK script.
sed -i 's@exec /system/bin/sh@exec /bin/sh@g' "$TMP/runner.sh"
cat > "$PREFIX/libexec/dsh-mobile/android-exec.sh" <<'MOCK'
#!/bin/sh
printf 'mode=%s|workspace=%s|command=%s|arg=%s' \
  "$DSH_ANDROID_SANDBOX_MODE" "$DSH_ANDROID_SANDBOX_WORKSPACE_ROOT" "$1" "$2"
MOCK
export TERMUX__PREFIX="$PREFIX"
export HOME="$TMP/home"
export TMPDIR="$HOME/tmp"
# The upstream subprocess scrub removes DSH_* variables. The app-private
# executable bridge must still be found via the surviving TERMUX__PREFIX.
unset DSH_ANDROID_STANDALONE DSH_ANDROID_EXEC_BRIDGE || true
output="$(/bin/sh "$TMP/runner.sh" workspace-write "$WORK" -- /data/bin/sample 'hello world')"
test "$output" = "mode=workspace-write|workspace=$WORK|command=/data/bin/sample|arg=hello world"
if /bin/sh "$TMP/runner.sh" danger-full-access "$WORK" -- /data/bin/sample >/dev/null 2>&1; then
  echo '[FAIL] invalid sandbox execution mode unexpectedly accepted' >&2
  exit 1
fi
echo '[OK] scrubbed DSH_* child environment retains Termux bridge and sandbox mode'
