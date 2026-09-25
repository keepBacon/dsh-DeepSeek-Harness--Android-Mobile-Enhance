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

    # The upstream snapshot contains entries such as usr/bin/bash ->
    # /system/bin/sh. A plain cp to that destination follows the symlink and
    # attempts to overwrite Android's /system/bin/sh. Package payloads are the
    # authoritative overlay here, so replace incompatible destination nodes
    # without ever following them.
    if [ -L "$src" ]; then
      mkdir -p "$(dirname "$dest")"
      [ ! -e "$dest" ] && [ ! -L "$dest" ] || rm -rf -- "$dest"
      target="$(readlink "$src")"
      if [[ "$target" = "$host_prefix"/* ]]; then
        mapped="$stage/usr/${target#"$host_prefix"/}"
        relative="$(realpath -m --relative-to="$(dirname "$dest")" "$mapped")"
        ln -s "$relative" "$dest"
      else
        ln -s "$target" "$dest"
      fi
    elif [ -d "$src" ]; then
      if [ -L "$dest" ] || { [ -e "$dest" ] && [ ! -d "$dest" ]; }; then
        rm -rf -- "$dest"
      fi
      mkdir -p "$dest"
    elif [ -f "$src" ]; then
      mkdir -p "$(dirname "$dest")"
      [ ! -e "$dest" ] && [ ! -L "$dest" ] || rm -rf -- "$dest"
      cp -p -- "$src" "$dest"
    fi
  done < <(dpkg-query -L "$pkg" 2>/dev/null || true)
}

validate_staged_termux_payload_contract() {
  local stage="$1"
  local fail=0 cmd owner

  require_exact_tool() {
    cmd="$1"; owner="$2"
    if [ ! -x "$stage/usr/bin/$cmd" ]; then
      echo "[DSH] Embedded payload contract missing usr/bin/$cmd (expected from package: $owner)" >&2
      fail=1
    fi
  }

  require_binutils_tool() {
    cmd="$1"
    if [ ! -x "$stage/usr/bin/$cmd" ] && [ ! -x "$stage/usr/bin/g$cmd" ]; then
      echo "[DSH] Embedded payload contract missing $cmd/g$cmd (expected from package: binutils)" >&2
      fail=1
    fi
  }

  # OpenSSL deliberately splits the command-line binary into openssl-tool.
  # The openssl package alone contains libraries/config and is not sufficient.
  require_exact_tool openssl openssl-tool
  require_exact_tool file file
  require_exact_tool curl curl
  require_exact_tool jq jq
  require_exact_tool proot proot
  require_exact_tool python3 python
  require_exact_tool aapt2 aapt2
  require_exact_tool gdb gdb
  require_exact_tool gdbserver gdb
  require_exact_tool strace strace
  require_exact_tool rizin rizin
  require_exact_tool frida frida
  require_exact_tool frida-ps frida
  require_exact_tool frida-trace frida
  require_exact_tool frida-server frida
  for cmd in readelf objdump nm strings; do
    require_binutils_tool "$cmd"
  done

  if [ "$fail" -ne 0 ]; then
    echo "[DSH] Embedded Termux payload contract failed before native-module compilation." >&2
    echo "[DSH] Host package ownership diagnostics:" >&2
    for cmd in openssl file curl jq proot python3 aapt2 gdb gdbserver strace rizin frida frida-ps frida-trace frida-server readelf greadelf objdump gobjdump nm gnm strings gstrings; do
      local host_path="${PREFIX:-/data/data/com.termux/files/usr}/bin/$cmd"
      if [ -e "$host_path" ]; then
        dpkg-query -S "$host_path" 2>/dev/null | head -n 1 >&2 || true
      fi
    done
    return 7
  fi
  echo "[DSH] Embedded Termux payload contract: OK"
}

dsh_write_build_sources() {
  local file="$1" base="$2"
  mkdir -p "$(dirname "$file")"
  {
    printf 'deb %s/termux-main stable main\n' "$base"
    if [ -n "${DSH_TERMUX_ROOT_TOOL_PACKAGES:-}" ]; then
      printf 'deb %s/termux-root root stable\n' "$base"
    fi
  } > "$file"
}

dsh_apt_with_isolated_sources() {
  local source_file="$1" lists_dir="$2"
  shift 2
  mkdir -p "$lists_dir/partial"
  apt-get \
    -o "Dir::Etc::sourcelist=$source_file" \
    -o "Dir::Etc::sourceparts=-" \
    -o "Dir::State::lists=$lists_dir" \
    -o "Acquire::Retries=3" \
    -o "Acquire::http::Timeout=30" \
    -o "Acquire::https::Timeout=30" \
    -o "APT::Get::List-Cleanup=0" \
    "$@"
}

dsh_install_missing_termux_packages() {
  local packages=("$@")
  [ "${#packages[@]}" -gt 0 ] || return 0

  local attempt=0 base label source_file lists_dir
  local bases=(
    "${DSH_TERMUX_PRIMARY_APT_BASE:-https://packages.termux.dev/apt}"
    "${DSH_TERMUX_FALLBACK_APT_BASE:-https://packages-cf.termux.dev/apt}"
  )

  for base in "${bases[@]}"; do
    [ -n "$base" ] || continue
    attempt=$((attempt + 1))
    label="mirror-$attempt"
    source_file="$CACHE_DIR/dsh-termux-$label.list"
    lists_dir="$CACHE_DIR/dsh-termux-apt-lists-$label"
    rm -rf "$lists_dir"
    dsh_write_build_sources "$source_file" "$base"

    echo "[DSH] Resolving missing Termux packages via $base"
    if dsh_apt_with_isolated_sources "$source_file" "$lists_dir" update && \
       DEBIAN_FRONTEND=noninteractive dsh_apt_with_isolated_sources "$source_file" "$lists_dir" install -y "${packages[@]}"; then
      return 0
    fi
    echo "[DSH] Termux mirror attempt failed: $base" >&2
  done

  return 7
}

dsh_normalize_staged_apt_sources() {
  local stage="$1"
  local apt_dir="$stage/usr/etc/apt"
  mkdir -p "$apt_dir/sources.list.d"

  # The embedded runtime must not inherit a transiently broken host mirror.
  # Use the authoritative direct Termux endpoint in the packaged app while
  # leaving the user's actual Termux source configuration untouched.
  cat > "$apt_dir/sources.list" <<'EOF_DSH_MAIN_SOURCE'
deb https://packages.termux.dev/apt/termux-main stable main
EOF_DSH_MAIN_SOURCE

  rm -f "$apt_dir/sources.list.d/root.list" "$apt_dir/sources.list.d/dsh-root.list"
  if [ -n "${DSH_TERMUX_ROOT_TOOL_PACKAGES:-}" ]; then
    cat > "$apt_dir/sources.list.d/root.list" <<'EOF_DSH_ROOT_SOURCE'
deb https://packages.termux.dev/apt/termux-root root stable
EOF_DSH_ROOT_SOURCE
  fi
}

install_termux_tool_runtime() {
  local stage="$1"
  [ "${DSH_TERMUX_TOOLS:-1}" = "1" ] || { echo "[DSH] Embedded Termux tool runtime disabled."; return 0; }
  for cmd in pkg apt-get apt-cache dpkg-query proot python3 file; do
    command -v "$cmd" >/dev/null 2>&1 || {
      echo "[DSH] 缺少 Termux 工具 $cmd。" >&2
      echo "[DSH] 建议先执行: pkg install apt proot python python-pip jq coreutils findutils grep sed gawk gzip zip less which procps make file binutils openssl openssl-tool aapt2 -y" >&2
      return 7
    }
  done

  local roots=() pkg
  read -r -a roots <<< "${DSH_TERMUX_TOOL_PACKAGES:-} ${DSH_TERMUX_ROOT_TOOL_PACKAGES:-} ${DSH_EXTRA_TERMUX_PACKAGES:-}"
  local missing_roots=()
  for pkg in "${roots[@]}"; do
    [ -n "$pkg" ] || continue
    if [ "$(dpkg-query -W -f='${db:Status-Status}' "$pkg" 2>/dev/null || true)" != "installed" ]; then
      missing_roots+=("$pkg")
    fi
  done

  # Never refresh repositories merely because dynamic tools are enabled.
  # If everything is already installed, the build remains fully offline.
  if [ "${#missing_roots[@]}" -gt 0 ]; then
    if [ "${DSH_AUTO_INSTALL_TERMUX_TOOLS:-1}" = "1" ]; then
      echo "[DSH] Installing missing Termux tool packages: ${missing_roots[*]}"
      dsh_install_missing_termux_packages "${missing_roots[@]}" || {
        echo "[DSH] 自动安装 Termux 工具包失败: ${missing_roots[*]}" >&2
        echo "[DSH] 已尝试 direct + Cloudflare Termux 官方源，且没有修改宿主 sources.list。" >&2
        echo "[DSH] 网络恢复后可直接重新执行 build-termux.sh；已安装工具不会重复刷新源。" >&2
        return 7
      }
    else
      echo "[DSH] Termux 工具包未安装: ${missing_roots[*]}" >&2
      echo "[DSH] 请安装后重试。Frida 位于 Termux root repository。" >&2
      return 7
    fi
  else
    echo "[DSH] Required Termux tool packages already installed; skipping repository refresh."
  fi
  for pkg in "${roots[@]}"; do
    [ -n "$pkg" ] || continue
    [ "$(dpkg-query -W -f='${db:Status-Status}' "$pkg" 2>/dev/null || true)" = "installed" ] || {
      echo "[DSH] Termux 工具包安装后仍不可用: $pkg" >&2
      return 7
    }
  done

  local package_list="$CACHE_DIR/dsh-termux-tool-packages.txt"
  resolve_termux_package_closure "${roots[@]}" > "$package_list"
  [ -s "$package_list" ] || { echo "[DSH] Termux 工具依赖闭包为空。" >&2; return 7; }
  echo "[DSH] Bundling Termux tool/package-manager closure: $(wc -l < "$package_list") packages"

  mkdir -p "$stage/usr/bin" "$stage/usr/lib" "$stage/usr/libexec/dsh/pm-bin" "$stage/usr/libexec/dsh/wrappers" \
    "$stage/usr/var/lib/dpkg/info" "$stage/usr/var/lib/dpkg/updates" "$stage/usr/var/lib/dpkg/triggers" \
    "$stage/usr/var/lib/apt/lists/partial" "$stage/usr/var/cache/apt/archives/partial" "$stage/usr/tmp"

  local package_index=0 package_total
  package_total="$(wc -l < "$package_list" | tr -d ' ')"
  while IFS= read -r pkg; do
    [ -n "$pkg" ] || continue
    package_index=$((package_index + 1))
    if [ "$package_index" -eq 1 ] || [ $((package_index % 10)) -eq 0 ] || [ "$package_index" -eq "$package_total" ]; then
      echo "[DSH]   overlay package $package_index/$package_total: $pkg"
    fi
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
  dsh_normalize_staged_apt_sources "$stage"

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
case "$CMD" in
  *[!A-Za-z0-9._+-]*|'') echo "invalid embedded command: $CMD" >&2; exit 2 ;;
esac
shift
/system/bin/mkdir -p "$REAL_HOME" "$REAL_HOME/tmp"
# Do NOT fake uid 0 here. Termux apt/pkg are intentionally designed to run
# as the app uid because the prefix is app-writable, and current Termux builds
# explicitly reject uid 0 for safety. PRoot is used only for path translation.
exec "$REAL_PREFIX/bin/proot" --link2symlink \
  -b "$REAL_PREFIX:$LEGACY_PREFIX" \
  -b "$REAL_HOME:$LEGACY_HOME" \
  -b /proc \
  -b /dev \
  -w "$PWD" \
  /system/bin/env \
    DSH_TERMUX_INNER=1 \
    HOME="$LEGACY_HOME" PREFIX="$LEGACY_PREFIX" TERMUX__PREFIX="$LEGACY_PREFIX" TERMUX_PREFIX="$LEGACY_PREFIX" \
    TMPDIR="$LEGACY_HOME/tmp" PATH="$LEGACY_PREFIX/bin:/system/bin" \
    LD_LIBRARY_PATH="$LEGACY_PREFIX/lib" SHELL="$LEGACY_PREFIX/bin/bash" \
    "$LEGACY_PREFIX/bin/$CMD" "$@"
EOF_TERMUX_RUN
  chmod 0755 "$stage/usr/libexec/dsh/termux-run"

  cat > "$stage/usr/libexec/dsh/termux-wrapper" <<'EOF_TERMUX_WRAPPER'
#!/system/bin/sh
set -eu
name="${0##*/}"
prefix="${TERMUX__PREFIX:-${PREFIX:-}}"
[ -n "$prefix" ] || { echo "TERMUX__PREFIX is not set" >&2; exit 125; }
case "$name" in
  python) command_name="python3" ;;
  # Termux's GNU binutils package deliberately installs the tools that conflict
  # with LLVM under g-prefixed names (greadelf, gobjdump, gnm, ...). The DSH
  # tool surface keeps conventional names so agents/plugins do not need
  # Termux-specific knowledge. Prefer an unprefixed implementation when one is
  # present, otherwise dispatch to the GNU g-prefixed binary.
  ar|addr2line|c++filt|nm|objcopy|objdump|ranlib|readelf|size|strings|strip)
    if [ -x "$prefix/bin/$name" ]; then
      command_name="$name"
    elif [ -x "$prefix/bin/g$name" ]; then
      command_name="g$name"
    else
      echo "embedded binary-analysis command not found: $name (also tried g$name)" >&2
      exit 127
    fi
    ;;
  *) command_name="$name" ;;
esac
if [ "${DSH_TERMUX_INNER:-0}" = "1" ]; then
  exec "$prefix/bin/$command_name" "$@"
fi
exec "$prefix/libexec/dsh/termux-run" "$command_name" "$@"
EOF_TERMUX_WRAPPER
  chmod 0755 "$stage/usr/libexec/dsh/termux-wrapper"

  # Keep package-owned files under usr/bin intact so apt/pkg upgrades can
  # replace them normally. DSH prepends this wrapper directory to PATH, which
  # keeps relocation/proot entry stable even after package-manager self-updates.
  # Any tool in this list is always launched through termux-run. This gives it
  # the legacy /data/data/com.termux/files/usr view that upstream Termux
  # packages were compiled/configured for, rather than hoping that every
  # binary is fully relocatable when copied into the app-private runtime.
  for cmd in apt apt-get apt-cache apt-config dpkg dpkg-query dpkg-deb pkg python python3 pip pip3 \
    openssl file curl jq aapt2 rizin rz-asm rz-bin rz-find frida frida-ps frida-trace \
    ar addr2line c++filt nm objcopy objdump ranlib readelf size strings strip; do
    rm -f "$stage/usr/libexec/dsh/wrappers/$cmd"
    ln -s ../termux-wrapper "$stage/usr/libexec/dsh/wrappers/$cmd"
  done
  rm -f "$stage/usr/libexec/dsh/wrappers/termux-run"
  ln -s ../termux-run "$stage/usr/libexec/dsh/wrappers/termux-run"

  while IFS= read -r -d '' elf; do
    case "$(file -b "$elf" 2>/dev/null || true)" in *ELF*) copy_link_deps "$elf" "$stage/usr/lib" ;; esac
  done < <(find "$stage/usr/bin" "$stage/usr/libexec/dsh/pm-bin" -maxdepth 1 -type f -print0 2>/dev/null)

  # Validate package contents immediately. Do not spend minutes compiling
  # node-pty only to discover that a requested Termux subpackage did not
  # actually contribute its executable to the staged runtime.
  validate_staged_termux_payload_contract "$stage" || return 7

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
  local binutils_log="$CACHE_DIR/embedded-binutils-smoke.log"
  for cmd in readelf objdump nm strings; do
    if ! "${common_env[@]}" "$wrappers/$cmd" --version >"$binutils_log" 2>&1; then
      echo "[DSH] Embedded binary-analysis tool failed: $cmd" >&2
      echo "[DSH] Tried conventional $cmd with GNU g$cmd fallback through the runtime wrapper." >&2
      sed -n '1,80p' "$binutils_log" >&2 || true
      return 7
    fi
  done
  local openssl_log="$CACHE_DIR/embedded-openssl-smoke.log"
  if ! "${common_env[@]}" "$wrappers/openssl" version >"$openssl_log" 2>&1; then
    echo "[DSH] Embedded OpenSSL smoke test failed through relocation wrapper." >&2
    echo "[DSH] This usually means the staged Termux payload or one of its shared libraries/config paths is incomplete." >&2
    sed -n '1,120p' "$openssl_log" >&2 || true
    return 7
  fi

  local file_log="$CACHE_DIR/embedded-file-smoke.log"
  if ! "${common_env[@]}" "$wrappers/file" --version >"$file_log" 2>&1; then
    echo "[DSH] Embedded file(1) smoke test failed through relocation wrapper." >&2
    sed -n '1,120p' "$file_log" >&2 || true
    return 7
  fi

  local aapt2_log="$CACHE_DIR/embedded-aapt2-smoke.log"
  if ! "${common_env[@]}" "$wrappers/aapt2" version >"$aapt2_log" 2>&1; then
    echo "[DSH] Embedded aapt2 smoke test failed through relocation wrapper." >&2
    sed -n '1,120p' "$aapt2_log" >&2 || true
    return 7
  fi

  local dynamic_log="$CACHE_DIR/embedded-dynamic-analysis-smoke.log"
  if ! "${common_env[@]}" "$stage/usr/bin/gdb" --version >"$dynamic_log" 2>&1; then
    echo '[DSH] Embedded gdb smoke test failed.' >&2; sed -n '1,100p' "$dynamic_log" >&2 || true; return 7
  fi
  if ! "${common_env[@]}" "$stage/usr/bin/strace" -V >"$dynamic_log" 2>&1; then
    echo '[DSH] Embedded strace smoke test failed.' >&2; sed -n '1,100p' "$dynamic_log" >&2 || true; return 7
  fi
  if ! "${common_env[@]}" "$wrappers/rizin" -v >"$dynamic_log" 2>&1; then
    echo '[DSH] Embedded Rizin smoke test failed.' >&2; sed -n '1,100p' "$dynamic_log" >&2 || true; return 7
  fi
  if ! "${common_env[@]}" "$wrappers/frida" --version >"$dynamic_log" 2>&1; then
    echo '[DSH] Embedded Frida client smoke test failed.' >&2; sed -n '1,120p' "$dynamic_log" >&2 || true; return 7
  fi

  local apt_log="$CACHE_DIR/embedded-apt-smoke.log"
  if ! "${common_env[@]}" "$wrappers/apt" --version >"$apt_log" 2>&1; then
    echo "[DSH] Embedded apt smoke test failed. Diagnostic (host uid=$(id -u 2>/dev/null || echo unknown)):" >&2
    sed -n '1,80p' "$apt_log" >&2 || true
    return 7
  fi

  local pkg_log="$CACHE_DIR/embedded-pkg-smoke.log"
  if ! "${common_env[@]}" "$wrappers/pkg" list-installed >"$pkg_log" 2>&1; then
    echo "[DSH] Embedded pkg smoke test failed. Diagnostic (host uid=$(id -u 2>/dev/null || echo unknown)):" >&2
    sed -n '1,80p' "$pkg_log" >&2 || true
    return 7
  fi
  echo "[DSH] Embedded tools: OK (pkg/apt/dpkg + python3/pip + binutils + openssl + gdb/strace/rizin/frida + common CLI)"
}
