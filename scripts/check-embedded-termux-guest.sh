#!/usr/bin/env bash
set -Eeuo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SOURCE="$ROOT/scripts/embed-termux-tools.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

PREFIX="$TMP/com.dshmobile.shell/files/usr"
HOME_DIR="$TMP/com.dshmobile.shell/files/home"
WORK="$TMP/workspace"
mkdir -p "$PREFIX/bin" "$HOME_DIR" "$WORK"
printf 'DO NOT CHANGE USER HOME\n' > "$HOME_DIR/sentinel"
BEFORE="$(sha256sum "$HOME_DIR/sentinel" | awk '{print $1}')"
mkdir -p "$PREFIX/libexec/dsh"
awk '/^  cat > "\$stage\/usr\/libexec\/dsh\/termux-run" <<'\''EOF_TERMUX_RUN'\''$/{capture=1;next} /^EOF_TERMUX_RUN$/{capture=0} capture{print}' "$SOURCE" > "$TMP/termux-run"
test -s "$TMP/termux-run"
sh -n "$TMP/termux-run"

# In this portable test /system does not exist. Only replace command paths
# inside the extracted fixture, never in the shipped Android launcher.
sed -i 's@/system/bin/mkdir@/bin/mkdir@g;s@/system/bin/env@/usr/bin/env@g' "$TMP/termux-run"
cat > "$PREFIX/bin/proot" <<'EOF_MOCK'
#!/usr/bin/env sh
: "${DSH_MOCK_PROOT_CAPTURE:?}"
printf '%s\n' "$@" > "$DSH_MOCK_PROOT_CAPTURE"
# PRoot must use an existing app-owned host directory *before* guest mounts.
[ -d "$PROOT_TMP_DIR" ] || exit 82
[ -w "$PROOT_TMP_DIR" ] || exit 83
printf '%s\n' "$PROOT_TMP_DIR" > "$DSH_MOCK_PROOT_CAPTURE.tmp"
EOF_MOCK
chmod 0700 "$PREFIX/bin/proot"
# The fake command is never executed by mock proot.
touch "$PREFIX/bin/bash"
cat > "$PREFIX/bin/env" <<'EOF_ENV'
#!/usr/bin/env sh
exit 0
EOF_ENV
chmod 0700 "$PREFIX/bin/env"

# The test runner does not own /data/data/com.termux/files: exercise the APK
# fallback with app-private mountpoints, not the real Termux host branch.
export DSH_MOCK_PROOT_CAPTURE="$TMP/captured-argv"
(cd "$WORK" && PROOT_TMP_DIR="/data/data/com.termux/files/usr/tmp" \
  TERMUX__PREFIX="$PREFIX" PREFIX="$PREFIX" HOME="$HOME_DIR" \
  sh "$TMP/termux-run" bash --noprofile --norc -c 'printf "%s" "hello world"')
test "$(cat "$DSH_MOCK_PROOT_CAPTURE.tmp")" = "$HOME_DIR/tmp"
test -s "$DSH_MOCK_PROOT_CAPTURE"
# Prefix relocation must NOT hide Android system paths behind an empty root.
if grep -Fxq -- '-r' "$DSH_MOCK_PROOT_CAPTURE"; then
  echo '[FAIL] PRoot still starts with an empty guest root' >&2
  exit 1
fi
grep -Fxq -- '/system/bin/sh' "$DSH_MOCK_PROOT_CAPTURE"
grep -Fxq -- "$TMP/com.dshmobile.shell/files/.dsh-proot-guest/data/data/com.termux:/data/data/com.termux" "$DSH_MOCK_PROOT_CAPTURE"
grep -Fxq -- "$TMP/com.dshmobile.shell/files/.dsh-proot-guest" "$DSH_MOCK_PROOT_CAPTURE"
grep -Fxq -- "$PREFIX:/data/data/com.termux/files/usr" "$DSH_MOCK_PROOT_CAPTURE"
if grep -Fxq -- '/data/data/com.termux/files/usr/bin/env' "$DSH_MOCK_PROOT_CAPTURE"; then
  echo '[FAIL] unsafe guest env bootstrap remains' >&2
  exit 1
fi
grep -Fxq -- 'dsh-termux-guest' "$DSH_MOCK_PROOT_CAPTURE"
grep -Fxq -- "$HOME_DIR:/data/data/com.termux/files/home" "$DSH_MOCK_PROOT_CAPTURE"
grep -Fxq -- '--noprofile' "$DSH_MOCK_PROOT_CAPTURE"
grep -Fxq -- '--norc' "$DSH_MOCK_PROOT_CAPTURE"
grep -Fxq -- 'printf "%s" "hello world"' "$DSH_MOCK_PROOT_CAPTURE"
test -d "$TMP/com.dshmobile.shell/files/.dsh-proot-guest/data/data/com.termux/files/usr"
test -d "$TMP/com.dshmobile.shell/files/.dsh-proot-guest/data/data/com.termux/files/home"
AFTER="$(sha256sum "$HOME_DIR/sentinel" | awk '{print $1}')"
test "$BEFORE" = "$AFTER"
echo '[OK] Virtual Android guest mountpoints, argv fidelity and HOME preservation'
echo '[NOTE] This portable test uses a mock PRoot; real Android execution still requires device validation.'
