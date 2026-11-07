#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
bridge="$ROOT/scripts/dsh-android-exec.sh"
mkdir -p "$TMP/usr/bin" "$TMP/workspace"
cp /usr/bin/printf "$TMP/usr/bin/printf"
cp "$(command -v python3)" "$TMP/usr/bin/python3"
cat > "$TMP/linker" <<'SH'
#!/bin/sh
printf '%s\n' "$1" >> "$DSH_LINKER_PROBE_LOG"
exec "$@"
SH
chmod +x "$TMP/linker"
export DSH_LINKER_PROBE_LOG="$TMP/linker-called.log"
export DSH_ANDROID_LINKER64="$TMP/linker"
export DSH_ANDROID_HEAD="$(command -v head)"
export TERMUX__PREFIX="$TMP/usr"

out="$(/bin/sh "$bridge" "$TMP/usr/bin/printf" 'linker-ok')"
test "$out" = "linker-ok"
grep -Fxq "$TMP/usr/bin/printf" "$DSH_LINKER_PROBE_LOG"

# A workspace ELF is not inside the Termux usr/bin directory. It still gets
# passed to the system-linker bridge rather than execve(workspace-path).
# GNU printf is a coreutils multicall executable and rejects a renamed argv0.
# Python's ELF can execute under a different basename, which makes this a
# suitable realistic workspace binary test.
cp "$(command -v python3)" "$TMP/workspace/external-program"
out="$(/bin/sh "$bridge" "$TMP/workspace/external-program" -c 'import sys;print("|".join(sys.argv[1:]))' 'alpha' 'beta')"
test "$out" = "alpha|beta"
grep -Fxq "$TMP/workspace/external-program" "$DSH_LINKER_PROBE_LOG"

cat > "$TMP/workspace/script.py" <<'PY'
#!/data/data/com.termux/files/usr/bin/python3
import sys
print('|'.join(sys.argv[1:]))
PY
out="$(/bin/sh "$bridge" "$TMP/workspace/script.py" 'one' 'two with spaces')"
test "$out" = "one|two with spaces"

printf 'plain text, not a command\n' > "$TMP/workspace/not-elf"
if /bin/sh "$bridge" "$TMP/workspace/not-elf" >/dev/null 2>&1; then
  echo '[FAIL] bridge must reject non-executable text' >&2
  exit 1
fi
printf '%s\n' '[OK] app-private ELF + workspace ELF + legacy interpreter + argv boundaries'
