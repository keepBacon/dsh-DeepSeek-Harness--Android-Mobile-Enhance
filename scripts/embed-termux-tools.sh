#!/data/data/com.termux/files/usr/bin/bash

# Embedded Termux-like package/tool runtime for DSH Mobile.
# Sourced by build-termux.sh after copy_link_deps() is defined.

resolve_termux_package_closure() {
  local roots=("$@")
  {
    printf '%s\n' "${roots[@]}"
    apt-cache depends --installed --recurse --no-recommends --no-suggests --no-conflicts --no-breaks --no-replaces --no-enhances "${roots[@]}" 2>/dev/null \
      | awk '/^[A-Za-z0-9][A-Za-z0-9+.:_-]*$/ { print $1; next } /^[[:space:]]*(Pre)?Depends:/ { sub(/^[[:space:]]*(Pre)?Depends:[[:space:]]*/, ""); gsub(/[<>]/, ""); if ($1 != "") print $1 }'
  } | sed 's/:any$//' | awk 'NF && !seen[$0]++' \
    | while IFS= read -r pkg; do
        [ "$(dpkg-query -W -f='${db:Status-Status}' "$pkg" 2>/dev/null || true)" = "installed" ] && printf '%s\n' "$pkg"
      done
}

copy_termux_package_payload() {
  local stage="$1" pkg="$2"
  local host_prefix="${PREFIX:-/data/data/com.termux/files/usr}"
  local src rel dest target mapped relative
  while IFS= read -r src; do
    [ -n "$src" ] || continue
    case "$src" in
      "$host_prefix") continue ;;
      "$host_prefix"/*) rel="${src#"$host_prefix"/}" ;;
      *) continue ;;
    esac
    dest="$stage/usr/$rel"
    if [ -L "$src" ]; then
      mkdir -p "$(dirname "$dest")"
      target="$(readlink "$src")"
      rm -f "$dest"
      if [[ "$target" = "$host_prefix"/* ]]; then
        mapped="$stage/usr/${target#"$host_prefix"/}"
        relative="$(realpath -m --relative-to="$(dirname "$dest")" "$mapped")"
        ln -s "$relative" "$dest"
      else
        ln -s "$target" "$dest"
      fi
    elif [ -d "$src" ]; then
      mkdir -p "$dest"
    elif [ -f "$src" ]; then
      mkdir -p "$(dirname "$dest")"
      cp -p "$src" "$dest"
    fi
  done < <(dpkg-query -L "$pkg" 2>/dev/null || true)
}

install_termux_tool_runtime() {
  local stage="$1"
  [ "${DSH_TERMUX_TOOLS:-1}" = "1" ] || { echo "[DSH] Embedded Termux tool runtime disabled."; return 0; }
  for cmd in apt-cache dpkg-query proot python3; do
    command -v "$cmd" >/dev/null 2>&1 || {
      echo "[DSH] 缺少 Termux 工具 $cmd。" >&2
      echo "[DSH] 执行: pkg install proot python python-pip jq coreutils findutils grep sed gawk gzip zip less which procps make -y" >&2
      return 7
    }
  done

  local roots=() pkg
  read -r -a roots <<< "${DSH_TERMUX_TOOL_PACKAGES:-} ${DSH_EXTRA_TERMUX_PACKAGES:-}"
  for pkg in "${roots[@]}"; do
    [ -n "$pkg" ] || continue
    if [ "$(dpkg-query -W -f='${db:Status-Status}' "$pkg" 2>/dev/null || true)" != "installed" ]; then
      echo "[DSH] Termux 工具包未安装: $pkg" >&2
      echo "[DSH] 请先执行: pkg install $pkg -y" >&2
      return 7
    fi
  done

  local package_list="$CACHE_DIR/dsh-termux-tool-packages.txt"
  resolve_termux_package_closure "${roots[@]}" > "$package_list"
  [ -s "$package_list" ] || { echo "[DSH] Termux 工具依赖闭包为空。" >&2; return 7; }
  echo "[DSH] Bundling Termux tool/package-manager closure: $(wc -l < "$package_list") packages"

  mkdir -p "$stage/usr/bin" "$stage/usr/lib" "$stage/usr/libexec/dsh/pm-bin" "$stage/usr/libexec/dsh/wrappers" \
    "$stage/usr/var/lib/dpkg/info" "$stage/usr/var/lib/dpkg/updates" "$stage/usr/var/lib/dpkg/triggers" \
    "$stage/usr/var/lib/apt/lists/partial" "$stage/usr/var/cache/apt/archives/partial" "$stage/usr/tmp"

  while IFS= read -r pkg; do
    [ -n "$pkg" ] || continue
    copy_termux_package_payload "$stage" "$pkg"
  done < "$package_list"

  : > "$stage/usr/var/lib/dpkg/status"
  while IFS= read -r pkg; do
    [ -n "$pkg" ] || continue
    dpkg-query -s "$pkg" 2>/dev/null >> "$stage/usr/var/lib/dpkg/status" || true
    printf '\n' >> "$stage/usr/var/lib/dpkg/status"
    for info in "${PREFIX:-/data/data/com.termux/files/usr}/var/lib/dpkg/info/$pkg".*; do
      [ -e "$info" ] || continue
      cp -a "$info" "$stage/usr/var/lib/dpkg/info/"
    done
  done < "$package_list"
  touch "$stage/usr/var/lib/dpkg/available"

  [ -d "${PREFIX:-/data/data/com.termux/files/usr}/var/lib/dpkg/alternatives" ] && cp -a "${PREFIX:-/data/data/com.termux/files/usr}/var/lib/dpkg/alternatives" "$stage/usr/var/lib/dpkg/" || true
  [ -d "${PREFIX:-/data/data/com.termux/files/usr}/etc/apt" ] && cp -a "${PREFIX:-/data/data/com.termux/files/usr}/etc/apt" "$stage/usr/etc/" || true

  local cmd src host_python
  for cmd in apt apt-get apt-cache apt-config dpkg dpkg-query dpkg-deb pkg; do
    src="$(command -v "$cmd" 2>/dev/null || true)"
    [ -n "$src" ] && [ -e "$src" ] || continue
    cp -Lf "$src" "$stage/usr/libexec/dsh/pm-bin/$cmd-real"
    chmod 0755 "$stage/usr/libexec/dsh/pm-bin/$cmd-real" || true
    copy_link_deps "$src" "$stage/usr/lib"
  done

  host_python="$(command -v python3)"
  cp -Lf "$host_python" "$stage/usr/libexec/dsh/pm-bin/python3-real"
  chmod 0755 "$stage/usr/libexec/dsh/pm-bin/python3-real"
  copy_link_deps "$host_python" "$stage/usr/lib"

  cat > "$stage/usr/libexec/dsh/termux-run" <<'EOF_TERMUX_RUN'
#!/system/bin/sh
set -eu
REAL_PREFIX="${TERMUX__PREFIX:-${PREFIX:-}}"
[ -n "$REAL_PREFIX" ] || { echo "TERMUX__PREFIX is not set" >&2; exit 125; }
REAL_HOME="${HOME:-${REAL_PREFIX%/usr}/home}"
LEGACY_ROOT="/data/data/com.termux/files"
LEGACY_PREFIX="$LEGACY_ROOT/usr"
LEGACY_HOME="$LEGACY_ROOT/home"
CMD="${1:-}"
[ -n "$CMD" ] || { echo "usage: termux-run <command> [args...]" >&2; exit 2; }
shift
mkdir -p "$REAL_HOME" "$REAL_HOME/tmp"
exec "$REAL_PREFIX/bin/proot" --link2symlink -0 \
  -b "$REAL_PREFIX:$LEGACY_PREFIX" \
  -b "$REAL_HOME:$LEGACY_HOME" \
  -w "$PWD" \
  /system/bin/env \
    DSH_TERMUX_INNER=1 \
    HOME="$LEGACY_HOME" PREFIX="$LEGACY_PREFIX" TERMUX__PREFIX="$LEGACY_PREFIX" TERMUX_PREFIX="$LEGACY_PREFIX" \
    TMPDIR="$LEGACY_HOME/tmp" PATH="$LEGACY_PREFIX/libexec/dsh/pm-bin:$LEGACY_PREFIX/bin:/system/bin" \
    LD_LIBRARY_PATH="$LEGACY_PREFIX/lib" SHELL="$LEGACY_PREFIX/bin/bash" \
    "$LEGACY_PREFIX/libexec/dsh/pm-bin/$CMD" "$@"
EOF_TERMUX_RUN
  chmod 0755 "$stage/usr/libexec/dsh/termux-run"

  cat > "$stage/usr/libexec/dsh/termux-wrapper" <<'EOF_TERMUX_WRAPPER'
#!/system/bin/sh
set -eu
name="$(basename "$0")"
prefix="${TERMUX__PREFIX:-${PREFIX:-}}"
[ -n "$prefix" ] || { echo "TERMUX__PREFIX is not set" >&2; exit 125; }
case "$name" in
  python|python3) real="python3-real" ;;
  pip|pip3)
    if [ "${DSH_TERMUX_INNER:-0}" = "1" ]; then exec "$prefix/libexec/dsh/pm-bin/python3-real" -m pip "$@"; fi
    exec "$prefix/libexec/dsh/termux-run" python3-real -m pip "$@"
    ;;
  *) real="$name-real" ;;
esac
if [ "${DSH_TERMUX_INNER:-0}" = "1" ]; then exec "$prefix/libexec/dsh/pm-bin/$real" "$@"; fi
exec "$prefix/libexec/dsh/termux-run" "$real" "$@"
EOF_TERMUX_WRAPPER
  chmod 0755 "$stage/usr/libexec/dsh/termux-wrapper"

  # Keep package-owned files under usr/bin intact so apt/pkg upgrades can
  # replace them normally. DSH prepends this wrapper directory to PATH, which
  # keeps relocation/proot entry stable even after package-manager self-updates.
  for cmd in apt apt-get apt-cache apt-config dpkg dpkg-query dpkg-deb pkg python python3 pip pip3; do
    rm -f "$stage/usr/libexec/dsh/wrappers/$cmd"
    ln -s ../termux-wrapper "$stage/usr/libexec/dsh/wrappers/$cmd"
  done
  rm -f "$stage/usr/libexec/dsh/wrappers/termux-run"
  ln -s ../termux-run "$stage/usr/libexec/dsh/wrappers/termux-run"

  while IFS= read -r -d '' elf; do
    case "$(file -b "$elf" 2>/dev/null || true)" in *ELF*) copy_link_deps "$elf" "$stage/usr/lib" ;; esac
  done < <(find "$stage/usr/bin" "$stage/usr/libexec/dsh/pm-bin" -maxdepth 1 -type f -print0 2>/dev/null)

  echo "[DSH] Embedded Termux package manager + Python tool runtime staged."
}

validate_termux_tool_runtime() {
  local stage="$1"
  [ "${DSH_TERMUX_TOOLS:-1}" = "1" ] || return 0
  local home="$CACHE_DIR/tool-runtime-smoke-home"
  rm -rf "$home"; mkdir -p "$home/tmp"
  local wrappers="$stage/usr/libexec/dsh/wrappers"
  local common_env=(env TERMUX__PREFIX="$stage/usr" PREFIX="$stage/usr" HOME="$home" TMPDIR="$home/tmp" PATH="$wrappers:$stage/usr/bin:/system/bin" LD_LIBRARY_PATH="$stage/usr/lib" TERMUX_EXEC__SYSTEM_LINKER_EXEC__MODE=force TERMUX_EXEC__EXECVE_CALL__INTERCEPT=1)
  "${common_env[@]}" "$wrappers/python3" -c 'import json, ssl, sqlite3, subprocess, sys; assert sys.version_info >= (3, 10); print(sys.version.split()[0])' >/dev/null || { echo "[DSH] Embedded Python3 smoke test failed."; return 7; }
  "${common_env[@]}" "$wrappers/pip3" --version >/dev/null 2>&1 || { echo "[DSH] Embedded pip smoke test failed."; return 7; }
  "${common_env[@]}" "$wrappers/dpkg-query" -W python >/dev/null 2>&1 || { echo "[DSH] Embedded dpkg database smoke test failed."; return 7; }
  "${common_env[@]}" "$wrappers/apt" --version >/dev/null 2>&1 || { echo "[DSH] Embedded apt smoke test failed."; return 7; }
  "${common_env[@]}" "$wrappers/pkg" list-installed >/dev/null 2>&1 || { echo "[DSH] Embedded pkg smoke test failed."; return 7; }
  echo "[DSH] Embedded tools: OK (pkg/apt/dpkg + python3/pip + common CLI)"
}
