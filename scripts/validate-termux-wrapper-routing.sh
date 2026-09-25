#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SOURCE="$ROOT/scripts/embed-termux-tools.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

PREFIX_DIR="$TMP/usr"
mkdir -p "$PREFIX_DIR/bin" "$PREFIX_DIR/libexec/dsh" "$PREFIX_DIR/libexec/dsh/wrappers"

# Extract the exact embedded wrapper body so this regression test validates
# what build-termux.sh will place into the APK, not a hand-written duplicate.
awk '/^  cat > "\$stage\/usr\/libexec\/dsh\/termux-wrapper" <<'\''EOF_TERMUX_WRAPPER'\''$/{capture=1;next} /^EOF_TERMUX_WRAPPER$/{capture=0} capture{print}' "$SOURCE" > "$PREFIX_DIR/libexec/dsh/termux-wrapper"
chmod 0755 "$PREFIX_DIR/libexec/dsh/termux-wrapper"

cat > "$PREFIX_DIR/libexec/dsh/termux-run" <<'EOF'
#!/usr/bin/env sh
printf '%s\n' "$1"
EOF
chmod 0755 "$PREFIX_DIR/libexec/dsh/termux-run"

for cmd in readelf openssl file; do
  ln -s ../termux-wrapper "$PREFIX_DIR/libexec/dsh/wrappers/$cmd"
done

# GNU binutils in Termux deliberately exposes greadelf instead of readelf.
: > "$PREFIX_DIR/bin/greadelf"; chmod 0755 "$PREFIX_DIR/bin/greadelf"
: > "$PREFIX_DIR/bin/openssl"; chmod 0755 "$PREFIX_DIR/bin/openssl"
: > "$PREFIX_DIR/bin/file"; chmod 0755 "$PREFIX_DIR/bin/file"

out="$(TERMUX__PREFIX="$PREFIX_DIR" "$PREFIX_DIR/libexec/dsh/wrappers/readelf" --version)"
[ "$out" = "greadelf" ] || { echo "[FAIL] readelf did not route to greadelf: $out" >&2; exit 1; }

out="$(TERMUX__PREFIX="$PREFIX_DIR" "$PREFIX_DIR/libexec/dsh/wrappers/openssl" version)"
[ "$out" = "openssl" ] || { echo "[FAIL] openssl did not route through termux-run: $out" >&2; exit 1; }

out="$(TERMUX__PREFIX="$PREFIX_DIR" "$PREFIX_DIR/libexec/dsh/wrappers/file" --version)"
[ "$out" = "file" ] || { echo "[FAIL] file did not route through termux-run: $out" >&2; exit 1; }

echo '[OK] Termux relocation-wrapper routing'
