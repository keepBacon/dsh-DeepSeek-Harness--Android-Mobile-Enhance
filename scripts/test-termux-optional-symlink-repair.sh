#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SOURCE="$ROOT/scripts/embed-termux-tools.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
export PREFIX="$TMP/termux/usr"
stage="$TMP/stage"
mkdir -p "$PREFIX/bin" "$stage/usr/bin"
# Tests the production function definitions directly, not a duplicate mock.
awk '
  /^dsh_materialize_host_entrypoint\(\) \{/ {copy=1}
  /^dsh_materialize_optional_host_entrypoints\(\) \{/ {copy=1}
  copy {print}
  copy && /^}/ {copy=0}
' "$SOURCE" > "$TMP/functions.sh"
source "$TMP/functions.sh"
printf '#!/bin/sh\nprintf "WORKS\\n"\n' > "$PREFIX/bin/real-tool"
chmod +x "$PREFIX/bin/real-tool"
ln -s real-tool "$PREFIX/bin/optional-tool"
ln -s missing-in-stage "$stage/usr/bin/optional-tool"
ln -s unresolved "$stage/usr/bin/not-on-host"
dsh_materialize_optional_host_entrypoints "$stage"
test -x "$stage/usr/bin/optional-tool"
test -x "$stage/usr/bin/real-tool"
test "$("$stage/usr/bin/optional-tool")" = WORKS
test -L "$stage/usr/bin/not-on-host"
test ! -e "$stage/usr/bin/not-on-host"
echo '[OK] optional Termux symlink repair preserves unresolved entries'
