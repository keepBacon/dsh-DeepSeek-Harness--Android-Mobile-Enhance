#!/data/data/com.termux/files/usr/bin/bash

# Embedded Termux-like package/tool runtime for DSH Mobile.
# Sourced by build-termux.sh after copy_link_deps() is defined.

resolve_termux_package_closure() {
  local roots=("$@")
  local dependency_output='' pkg
  local candidates=()

  # Keep apt-cache failure distinct from an ordinary "candidate is not installed"
  # result. The old pipeline ended with:
  #   [ installed ] && printf ...
  # so when the last candidate was not installed the while loop returned 1.
  # With build-termux.sh using set -Eeuo pipefail that normal filter condition
  # aborted the entire build and the ERR trap misleadingly pointed at awk.
  if ! dependency_output="$(apt-cache depends --installed --recurse --no-recommends --no-suggests --no-conflicts --no-breaks --no-replaces --no-enhances "${roots[@]}" 2>/dev/null)"; then
    echo "[DSH] apt-cache dependency closure query failed." >&2
    return 7
  fi

  while IFS= read -r pkg; do
    [ -n "$pkg" ] || continue
    candidates+=("$pkg")
  done < <(
    {
      printf '%s\n' "${roots[@]}"
      printf '%s\n' "$dependency_output" \
        | awk '/^[A-Za-z0-9][A-Za-z0-9+.:_-]*$/ { print $1; next } /^[[:space:]]*(Pre)?Depends:/ { sub(/^[[:space:]]*(Pre)?Depends:[[:space:]]*/, ""); gsub(/[<>]/, ""); if ($1 != "") print $1 }'
    } \
      | sed 's/:any$//' \
      | awk 'NF && !seen[$0]++'
  )

  for pkg in "${candidates[@]}"; do
    if [ "$(dpkg-query -W -f='${db:Status-Status}' "$pkg" 2>/dev/null || true)" = "installed" ]; then
      printf '%s\n' "$pkg"
    fi
  done
  return 0
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
  local fail=0 spec cmd owner mode

  for spec in "${DSH_TERMUX_REQUIRED_TOOL_SPECS[@]}"; do
    IFS='|' read -r cmd owner mode <<< "$spec"
    if [ ! -x "$stage/usr/bin/$cmd" ]; then
      echo "[DSH] Embedded payload contract missing usr/bin/$cmd (expected from package: $owner)" >&2
      fail=1
    fi
  done

  for cmd in "${DSH_TERMUX_BINUTILS_TOOLS[@]}"; do
    if [ ! -x "$stage/usr/bin/$cmd" ] && [ ! -x "$stage/usr/bin/g$cmd" ]; then
      echo "[DSH] Embedded payload contract missing $cmd/g$cmd (expected from package: binutils)" >&2
      fail=1
    fi
  done

  [ "$fail" -eq 0 ] || {
    echo "[DSH] Embedded extended Linux/TUI payload contract failed." >&2
    return 7
  }
  echo "[DSH] Embedded extended Linux/TUI payload contract: OK (${#DSH_TERMUX_REQUIRED_TOOL_SPECS[@]} commands)"
}
dsh_write_build_sources() {
  local file="$1" base="$2" include_root="${3:-0}"
  mkdir -p "$(dirname "$file")"
  {
    printf 'deb %s/termux-main stable main\n' "$base"
    if [ "$include_root" = "1" ]; then
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

  local attempt=0 base label source_file lists_dir pkg root_pkg include_root=0
  local bases=(
    "${DSH_TERMUX_PRIMARY_APT_BASE:-https://packages.termux.dev/apt}"
    "${DSH_TERMUX_FALLBACK_APT_BASE:-https://packages-cf.termux.dev/apt}"
  )

  for pkg in "${packages[@]}"; do
    for root_pkg in ${DSH_TERMUX_ROOT_TOOL_PACKAGES:-}; do
      if [ "$pkg" = "$root_pkg" ]; then
        include_root=1
        break 2
      fi
    done
  done

  for base in "${bases[@]}"; do
    [ -n "$base" ] || continue
    attempt=$((attempt + 1))
    label="mirror-$attempt"
    source_file="$CACHE_DIR/dsh-termux-$label.list"
    lists_dir="$CACHE_DIR/dsh-termux-apt-lists-$label"
    rm -rf "$lists_dir"
    dsh_write_build_sources "$source_file" "$base" "$include_root"

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


dsh_host_tool_owner() {
  local cmd="$1"
  local host_prefix="${PREFIX:-/data/data/com.termux/files/usr}"
  local path="$host_prefix/bin/$cmd"
  [ -e "$path" ] || return 1
  dpkg-query -S "$path" 2>/dev/null     | head -n 1     | sed -E 's/: .*//; s/:([^:]*)$//'
}

dsh_validate_host_tool_contract() {
  local host_prefix="${PREFIX:-/data/data/com.termux/files/usr}"
  local fail=0 spec cmd owner mode actual_owner

  for spec in "${DSH_TERMUX_REQUIRED_TOOL_SPECS[@]}"; do
    IFS='|' read -r cmd owner mode <<< "$spec"
    if [ ! -x "$host_prefix/bin/$cmd" ]; then
      echo "[DSH] Host tool contract missing: $host_prefix/bin/$cmd (expected seed: $owner)" >&2
      fail=1
      continue
    fi
    actual_owner="$(dsh_host_tool_owner "$cmd" || true)"
    [ -z "$actual_owner" ] || echo "[DSH] Tool owner: $cmd <- $actual_owner"
  done

  for cmd in "${DSH_TERMUX_BINUTILS_TOOLS[@]}"; do
    if [ ! -x "$host_prefix/bin/$cmd" ] && [ ! -x "$host_prefix/bin/g$cmd" ]; then
      echo "[DSH] Host tool contract missing: $cmd/g$cmd" >&2
      fail=1
    fi
  done

  if [ "$fail" -eq 0 ] && [ -x "$host_prefix/bin/frida" ]; then
    if ! "$host_prefix/bin/python3" - <<'PY_DSH_FRIDA_DEPS'
import importlib.metadata as md
import sys
required = ("prompt-toolkit", "colorama", "pygments", "websockets", "wcwidth")
missing = []
for name in required:
    try:
        md.distribution(name)
    except md.PackageNotFoundError:
        missing.append(name)
if missing:
    print("[DSH] Missing Frida Python runtime distributions: " + ", ".join(missing), file=sys.stderr)
    sys.exit(7)
PY_DSH_FRIDA_DEPS
    then
      fail=1
    fi
  fi

  [ "$fail" -eq 0 ] || {
    echo "[DSH] Host extended-tool preflight failed before staging." >&2
    return 7
  }
}

dsh_required_tool_owner_packages() {
  local spec cmd owner mode actual_owner
  for spec in "${DSH_TERMUX_REQUIRED_TOOL_SPECS[@]}"; do
    IFS='|' read -r cmd owner mode <<< "$spec"
    actual_owner="$(dsh_host_tool_owner "$cmd" || true)"
    [ -z "$actual_owner" ] || printf '%s\n' "$actual_owner"
  done
}

dsh_copy_python_distribution_closure() {
  local stage="$1"
  shift
  [ "$#" -gt 0 ] || return 0

  local host_prefix="${PREFIX:-/data/data/com.termux/files/usr}"
  local host_python="$host_prefix/bin/python3"
  local list="$CACHE_DIR/dsh-python-runtime-files.bin"
  : > "$list"

  "$host_python" - "$host_prefix" "$@" > "$list" <<'PY_DSH_DIST'
import importlib.metadata as md
import pathlib
import sys

prefix = pathlib.Path(sys.argv[1]).resolve()
files = []

for name in sys.argv[2:]:
    try:
        dist = md.distribution(name)
    except md.PackageNotFoundError:
        print(f"[DSH] Missing Python runtime distribution: {name}", file=sys.stderr)
        sys.exit(7)

    for item in dist.files or ():
        try:
            path = pathlib.Path(dist.locate_file(item)).resolve(strict=True)
            path.relative_to(prefix)
        except (OSError, ValueError):
            continue
        if path.is_file():
            files.append(path)

for path in dict.fromkeys(files):
    sys.stdout.buffer.write(str(path).encode("utf-8") + b"\0")
PY_DSH_DIST

  local src rel dest
  while IFS= read -r -d '' src; do
    case "$src" in
      "$host_prefix"/*) rel="${src#"$host_prefix"/}" ;;
      *) continue ;;
    esac
    dest="$stage/usr/$rel"
    mkdir -p "$(dirname "$dest")"
    cp -p -- "$src" "$dest"
    case "$src" in
      *.so|*.so.*) copy_link_deps "$src" "$stage/usr/lib" ;;
    esac
  done < "$list"
}


dsh_repair_termux_package_family() {
  local packages=("$@")
  [ "${#packages[@]}" -gt 0 ] || return 0

  local attempt=0 base label source_file lists_dir pkg root_pkg include_root=0
  local bases=(
    "${DSH_TERMUX_PRIMARY_APT_BASE:-https://packages.termux.dev/apt}"
    "${DSH_TERMUX_FALLBACK_APT_BASE:-https://packages-cf.termux.dev/apt}"
  )

  for pkg in "${packages[@]}"; do
    for root_pkg in ${DSH_TERMUX_ROOT_TOOL_PACKAGES:-}; do
      if [ "$pkg" = "$root_pkg" ]; then
        include_root=1
        break 2
      fi
    done
  done

  for base in "${bases[@]}"; do
    [ -n "$base" ] || continue
    attempt=$((attempt + 1))
    label="repair-$attempt"
    source_file="$CACHE_DIR/dsh-termux-$label.list"
    lists_dir="$CACHE_DIR/dsh-termux-apt-lists-$label"
    rm -rf "$lists_dir"
    dsh_write_build_sources "$source_file" "$base" "$include_root"

    echo "[DSH] Repairing ABI-sensitive Termux packages via $base: ${packages[*]}"
    if dsh_apt_with_isolated_sources "$source_file" "$lists_dir" update && \
       DEBIAN_FRONTEND=noninteractive dsh_apt_with_isolated_sources "$source_file" "$lists_dir" install -y --reinstall "${packages[@]}"; then
      return 0
    fi
    echo "[DSH] ABI repair mirror attempt failed: $base" >&2
  done

  return 7
}

dsh_run_tool_smoke() {
  local cmd="$1" bin="$2" log="$3"
  shift 3
  local prefix=("$@") found owner mode rc=0
  : > "$log"

  found="$(dsh_tool_spec_for "$cmd" || true)"
  [ -n "$found" ] || {
    echo "[DSH] No smoke contract registered for tool: $cmd" >"$log"
    return 64
  }
  IFS='|' read -r owner mode <<< "$found"

  case "$mode" in
    long) "${prefix[@]}" "$bin" --version >"$log" 2>&1 ;;
    short-v) "${prefix[@]}" "$bin" -v >"$log" 2>&1 ;;
    short-V) "${prefix[@]}" "$bin" -V >"$log" 2>&1 ;;
    word) "${prefix[@]}" "$bin" version >"$log" 2>&1 ;;
    dash-version) "${prefix[@]}" "$bin" -version >"$log" 2>&1 ;;
    sevenzip) "${prefix[@]}" "$bin" i >"$log" 2>&1 ;;
    help) "${prefix[@]}" "$bin" --help >"$log" 2>&1 ;;
    java) "${prefix[@]}" "$bin" -version >"$log" 2>&1 ;;
    exif) "${prefix[@]}" "$bin" -ver >"$log" 2>&1 ;;
    ip-version) "${prefix[@]}" "$bin" -Version >"$log" 2>&1 ;;
    help-any)
      set +e
      "${prefix[@]}" "$bin" --help >"$log" 2>&1
      rc=$?
      set -e
      [ "$rc" -eq 0 ] || [ "$rc" -eq 1 ]
      ;;
    android-root-conditional)
      set +e
      "${prefix[@]}" "$bin" --version >"$log" 2>&1
      rc=$?
      set -e
      if [ "$rc" -eq 0 ]; then
        return 0
      fi
      if grep -Eqi 'Termux.*without root|without root.*Termux|can.t do anything useful.*without root' "$log"; then
        echo "[DSH] $cmd is installed and starts, but this Termux build requires root for useful runtime access." >>"$log"
        return 0
      fi
      return "$rc"
      ;;
    *) echo "[DSH] Unknown smoke mode '$mode' for $cmd" >"$log"; return 64 ;;
  esac
}

dsh_host_required_tool_smoke() {
  local host_prefix="${PREFIX:-/data/data/com.termux/files/usr}"
  local log="$CACHE_DIR/host-required-tools-smoke.log"
  local spec cmd owner mode bin

  for spec in "${DSH_TERMUX_REQUIRED_TOOL_SPECS[@]}"; do
    IFS='|' read -r cmd owner mode <<< "$spec"
    bin="$host_prefix/bin/$cmd"
    [ -x "$bin" ] || { echo "[DSH] Host smoke executable missing: $cmd ($bin)" >&2; return 7; }
    if ! dsh_run_tool_smoke "$cmd" "$bin" "$log"; then
      echo "[DSH] Host tool smoke failed before staging: $cmd" >&2
      sed -n '1,120p' "$log" >&2 || true
      return 7
    fi
  done

  for cmd in readelf objdump nm strings; do
    bin="$host_prefix/bin/$cmd"
    [ -x "$bin" ] || bin="$host_prefix/bin/g$cmd"
    [ -x "$bin" ] || { echo "[DSH] Host binutils smoke executable missing: $cmd" >&2; return 7; }
    "$bin" --version >"$log" 2>&1 || return 7
  done
  echo "[DSH] Host extended Linux/TUI tool smoke: OK"
}

dsh_host_dynamic_tool_smoke() {
  local host_prefix="${PREFIX:-/data/data/com.termux/files/usr}"
  local log="$CACHE_DIR/host-dynamic-tool-smoke.log"

  dsh_run_tool_smoke gdb "$host_prefix/bin/gdb" "$log" || return 11
  dsh_run_tool_smoke gdbserver "$host_prefix/bin/gdbserver" "$log" || return 12
  dsh_run_tool_smoke strace "$host_prefix/bin/strace" "$log" || return 13
  dsh_run_tool_smoke rizin "$host_prefix/bin/rizin" "$log" || return 14
  dsh_run_tool_smoke frida "$host_prefix/bin/frida" "$log" || return 15
  dsh_run_tool_smoke frida-server "$host_prefix/bin/frida-server" "$log" || return 16
  return 0
}

dsh_repair_broken_host_dynamic_tools() {
  local rc=0 log="$CACHE_DIR/host-dynamic-tool-smoke.log"
  if dsh_host_dynamic_tool_smoke; then
    echo "[DSH] Host dynamic-analysis ABI smoke: OK"
    return 0
  else
    rc=$?
  fi

  echo "[DSH] Host dynamic-analysis ABI smoke failed (code=$rc)." >&2
  sed -n '1,120p' "$log" >&2 || true

  [ "${DSH_AUTO_INSTALL_TERMUX_TOOLS:-1}" = "1" ] || return 7

  case "$rc" in
    11|12)
      dsh_repair_termux_package_family libc++ gdb gdbserver libthread-db python || return 7
      ;;
    13)
      dsh_repair_termux_package_family strace || return 7
      ;;
    14)
      dsh_repair_termux_package_family libc++ rizin || return 7
      ;;
    15|16)
      dsh_repair_termux_package_family frida frida-python || return 7
      ;;
    *)
      dsh_repair_termux_package_family libc++ gdb gdbserver strace rizin frida frida-python || return 7
      ;;
  esac

  if ! dsh_host_dynamic_tool_smoke; then
    echo "[DSH] Host dynamic-analysis tools still fail after package-family repair." >&2
    sed -n '1,160p' "$log" >&2 || true
    return 7
  fi
  echo "[DSH] Host dynamic-analysis ABI repaired successfully."
}

dsh_sync_staged_dynamic_abi() {
  local stage="$1"
  local host_prefix="${PREFIX:-/data/data/com.termux/files/usr}"
  local cmd src host_cpp="$host_prefix/lib/libc++_shared.so"

  [ "${DSH_TERMUX_TOOLS:-1}" = "1" ] || return 0
  mkdir -p "$stage/usr/bin" "$stage/usr/lib"

  if [ -f "$host_cpp" ]; then
    cp -Lf "$host_cpp" "$stage/usr/lib/libc++_shared.so"
  fi

  for cmd in gdb gdbserver strace rizin frida-server; do
    src="$host_prefix/bin/$cmd"
    [ -x "$src" ] || continue
    cp -Lf "$src" "$stage/usr/bin/$cmd"
    chmod 0755 "$stage/usr/bin/$cmd" || true
    copy_link_deps "$src" "$stage/usr/lib"
  done

  # copy_link_deps may encounter libc++ through several tools; make the final
  # file deterministic and identical to the host package that passed smoke.
  [ -f "$host_cpp" ] && cp -Lf "$host_cpp" "$stage/usr/lib/libc++_shared.so"

  if command -v sha256sum >/dev/null 2>&1 && [ -f "$host_cpp" ] && [ -f "$stage/usr/lib/libc++_shared.so" ]; then
    local host_sha stage_sha
    host_sha="$(sha256sum "$host_cpp" | awk '{print $1}')"
    stage_sha="$(sha256sum "$stage/usr/lib/libc++_shared.so" | awk '{print $1}')"
    [ "$host_sha" = "$stage_sha" ] || {
      echo "[DSH] Staged libc++ checksum diverged from host after ABI sync." >&2
      return 7
    }
  fi
}

dsh_validate_staged_dynamic_abi() {
  local stage="$1"
  local log="$CACHE_DIR/embedded-dynamic-abi-preflight.log"
  local envv=(env LD_LIBRARY_PATH="$stage/usr/lib" PATH="$stage/usr/bin:/system/bin")

  if ! "${envv[@]}" "$stage/usr/bin/gdb" --version >"$log" 2>&1; then
    echo "[DSH] Early staged GDB ABI preflight failed." >&2
    sed -n '1,140p' "$log" >&2 || true
    return 7
  fi
  if ! "${envv[@]}" "$stage/usr/bin/gdbserver" --version >"$log" 2>&1; then
    echo "[DSH] Early staged gdbserver ABI preflight failed." >&2
    sed -n '1,140p' "$log" >&2 || true
    return 7
  fi
  if ! "${envv[@]}" "$stage/usr/bin/strace" -V >"$log" 2>&1; then
    echo "[DSH] Early staged strace ABI preflight failed." >&2
    sed -n '1,140p' "$log" >&2 || true
    return 7
  fi
  if ! "${envv[@]}" "$stage/usr/bin/rizin" -v >"$log" 2>&1; then
    echo "[DSH] Early staged Rizin ABI preflight failed." >&2
    sed -n '1,140p' "$log" >&2 || true
    return 7
  fi
  echo "[DSH] Early staged dynamic-analysis ABI preflight: OK"
}

DSH_TERMUX_TOOL_PREFLIGHT_DONE=0

dsh_preflight_termux_tool_packages() {
  [ "${DSH_TERMUX_TOOLS:-1}" = "1" ] || return 0
  [ "$DSH_TERMUX_TOOL_PREFLIGHT_DONE" = "1" ] && return 0

  local roots=() missing=() pkg
  read -r -a roots <<< "${DSH_TERMUX_TOOL_PACKAGES:-} ${DSH_TERMUX_ROOT_TOOL_PACKAGES:-} ${DSH_EXTRA_TERMUX_PACKAGES:-}"
  for pkg in "${roots[@]}"; do
    [ -n "$pkg" ] || continue
    if [ "$(dpkg-query -W -f='${db:Status-Status}' "$pkg" 2>/dev/null || true)" != "installed" ]; then
      missing+=("$pkg")
    fi
  done

  if [ "${#missing[@]}" -gt 0 ]; then
    [ "${DSH_AUTO_INSTALL_TERMUX_TOOLS:-1}" = "1" ] || {
      echo "[DSH] Missing extended Termux packages: ${missing[*]}" >&2
      return 7
    }
    echo "[DSH] Phase 1: installing extended Linux/TUI packages before Runtime rebuild (${#missing[@]} missing)…"
    dsh_install_missing_termux_packages "${missing[@]}" || return 7
  fi

  for pkg in "${roots[@]}"; do
    [ -n "$pkg" ] || continue
    [ "$(dpkg-query -W -f='${db:Status-Status}' "$pkg" 2>/dev/null || true)" = "installed" ] || {
      echo "[DSH] Package still unavailable after preflight install: $pkg" >&2
      return 7
    }
  done

  dsh_validate_host_tool_contract || return 7
  dsh_repair_broken_host_dynamic_tools || return 7
  dsh_host_required_tool_smoke || return 7
  DSH_TERMUX_TOOL_PREFLIGHT_DONE=1
  echo "[DSH] Phase 1 host tool preflight: OK"
}

install_termux_tool_runtime() {
  local stage="$1"
  [ "${DSH_TERMUX_TOOLS:-1}" = "1" ] || { echo "[DSH] Embedded Termux tool runtime disabled."; return 0; }
  for cmd in pkg apt-get apt-cache dpkg-query proot python3 file; do
    command -v "$cmd" >/dev/null 2>&1 || {
      echo "[DSH] 缺少 Termux 工具 $cmd。" >&2
      echo "[DSH] 基础环境缺失。构建器可自动补齐 gdb/strace/rizin/frida/frida-python；请先确保 pkg/apt/python/proot 可用。" >&2
      return 7
    }
  done

  dsh_preflight_termux_tool_packages || return 7
  local roots=() pkg
  read -r -a roots <<< "${DSH_TERMUX_TOOL_PACKAGES:-} ${DSH_TERMUX_ROOT_TOOL_PACKAGES:-} ${DSH_EXTRA_TERMUX_PACKAGES:-}"

  # Do not assume that a command is owned by the package name we seeded.
  # Termux frequently splits commands into subpackages (Frida is one example).
  # Discover the actual dpkg owner of every required executable and append it
  # to the staging roots so package-layout changes cannot silently omit tools.
  declare -A dsh_root_seen=()
  for pkg in "${roots[@]}"; do
    [ -n "$pkg" ] && dsh_root_seen["$pkg"]=1
  done
  local owner
  while IFS= read -r owner; do
    [ -n "$owner" ] || continue
    if [ -z "${dsh_root_seen[$owner]+x}" ]; then
      echo "[DSH] Adding actual tool-owner package to staging roots: $owner"
      roots+=("$owner")
      dsh_root_seen["$owner"]=1
    fi
  done < <(dsh_required_tool_owner_packages)

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

  # frida-python installs several runtime dependencies through pip in its
  # postinst. They are not listed by dpkg-query -L, so a pure package overlay
  # can contain the CLI scripts but still fail when Python imports their deps.
  if [ -x "${PREFIX:-/data/data/com.termux/files/usr}/bin/frida" ]; then
    dsh_copy_python_distribution_closure "$stage" prompt-toolkit colorama pygments websockets wcwidth || {
      echo "[DSH] Failed to stage Frida Python runtime dependencies." >&2
      return 7
    }
  fi

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
  local spec tool_cmd tool_owner tool_mode
  for tool_cmd in apt apt-get apt-cache apt-config dpkg dpkg-query dpkg-deb pkg python pip; do
    rm -f "$stage/usr/libexec/dsh/wrappers/$tool_cmd"
    ln -s ../termux-wrapper "$stage/usr/libexec/dsh/wrappers/$tool_cmd"
  done
  for spec in "${DSH_TERMUX_REQUIRED_TOOL_SPECS[@]}"; do
    IFS='|' read -r tool_cmd tool_owner tool_mode <<< "$spec"
    rm -f "$stage/usr/libexec/dsh/wrappers/$tool_cmd"
    ln -s ../termux-wrapper "$stage/usr/libexec/dsh/wrappers/$tool_cmd"
  done
  for tool_cmd in "${DSH_TERMUX_BINUTILS_TOOLS[@]}"; do
    rm -f "$stage/usr/libexec/dsh/wrappers/$tool_cmd"
    ln -s ../termux-wrapper "$stage/usr/libexec/dsh/wrappers/$tool_cmd"
  done
  rm -f "$stage/usr/libexec/dsh/wrappers/termux-run"
  ln -s ../termux-run "$stage/usr/libexec/dsh/wrappers/termux-run"

  while IFS= read -r -d '' elf; do
    case "$(file -b "$elf" 2>/dev/null || true)" in *ELF*) copy_link_deps "$elf" "$stage/usr/lib" ;; esac
  done < <(find "$stage/usr/bin" "$stage/usr/libexec/dsh/pm-bin" -maxdepth 1 -type f -print0 2>/dev/null)

  dsh_sync_staged_dynamic_abi "$stage" || return 7
  dsh_validate_staged_dynamic_abi "$stage" || return 7

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
  "${common_env[@]}" "$wrappers/dpkg-query" -W frida frida-python >/dev/null 2>&1 || { echo "[DSH] Embedded Frida package metadata missing from dpkg database."; return 7; }
  local binutils_log="$CACHE_DIR/embedded-binutils-smoke.log"
  for cmd in readelf objdump nm strings; do
    if ! "${common_env[@]}" "$wrappers/$cmd" --version >"$binutils_log" 2>&1; then
      echo "[DSH] Embedded binary-analysis tool failed: $cmd" >&2
      echo "[DSH] Tried conventional $cmd with GNU g$cmd fallback through the runtime wrapper." >&2
      sed -n '1,80p' "$binutils_log" >&2 || true
      return 7
    fi
  done
  local staged_tool_log="$CACHE_DIR/embedded-required-tools-smoke.log"
  local staged_cmd staged_bin staged_rc spec staged_owner staged_mode
  for spec in "${DSH_TERMUX_REQUIRED_TOOL_SPECS[@]}"; do
    IFS='|' read -r staged_cmd staged_owner staged_mode <<< "$spec"
    staged_bin="$wrappers/$staged_cmd"
    staged_rc=0
    dsh_run_tool_smoke "$staged_cmd" "$staged_bin" "$staged_tool_log" "${common_env[@]}" || staged_rc=$?
    if [ "$staged_rc" -ne 0 ]; then
      echo "[DSH] Embedded extended-tool smoke failed: $staged_cmd (provider=$staged_owner exit=$staged_rc)" >&2
      sed -n '1,160p' "$staged_tool_log" >&2 || true
      return 7
    fi
  done

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
  echo "[DSH] Embedded extended-tool smoke contract: OK (${#DSH_TERMUX_REQUIRED_TOOL_SPECS[@]} commands)"
  echo "[DSH] Embedded tools: OK (Linux/TUI/dev/network/database/document/Android CLI toolset)"
}
