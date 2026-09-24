#!/data/data/com.termux/files/usr/bin/bash
set -Eeuo pipefail
trap 'rc=$?; echo "[DSH] BUILD FAILED: line ${BASH_LINENO[0]:-$LINENO}, exit=$rc, command=$BASH_COMMAND" >&2' ERR

ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

SDK="${ANDROID_SDK_ROOT:-${ANDROID_HOME:-$HOME/android-sdk}}"
export ANDROID_SDK_ROOT="$SDK"
export ANDROID_HOME="$SDK"
export GRADLE_USER_HOME="${GRADLE_USER_HOME:-$HOME/.cache/dsh-mobile-gradle}"
SNAPSHOT="$ROOT/app/src/main/assets/snapshot.tar.xz"
RELEASE_APK_NAME="dsh-mobile-v0.10.1.apk"
RELEASE_APK_DOWNLOAD="/storage/emulated/0/Download/$RELEASE_APK_NAME"
CACHE_DIR="$HOME/.cache/dsh-mobile-runtime"
CACHE_APK="$CACHE_DIR/$RELEASE_APK_NAME"
RELEASE_URL="https://github.com/thness/dsh-mobile/releases/download/v0.10.1/$RELEASE_APK_NAME"
RELEASE_APK_SHA256="09b6ffcaeb48852b4e9f66516326f4f5441cfb9606e82a6cb81a41feb1bd79f7"
PNPM_VERSION="11.7.0"
DSH_VERSION="${DSH_VERSION:-0.1.5-rc.2}"
DSH_REFRESH_RUNTIME="${DSH_REFRESH_RUNTIME:-1}"
DSH_NATIVE_COMPAT="${DSH_NATIVE_COMPAT:-1}"
DSH_GIT_COMPAT="${DSH_GIT_COMPAT:-1}"
DSH_ALLOW_DEGRADED="${DSH_ALLOW_DEGRADED:-0}"
DSH_TERMUX_TOOLS="${DSH_TERMUX_TOOLS:-1}"
DSH_TERMUX_TOOL_PACKAGES="${DSH_TERMUX_TOOL_PACKAGES:-apt dpkg termux-tools termux-keyring proot python python-pip coreutils findutils grep sed gawk tar gzip xz-utils unzip zip curl jq less which procps make file}"
DSH_EXTRA_TERMUX_PACKAGES="${DSH_EXTRA_TERMUX_PACKAGES:-}"
# Favor faster first-launch extraction over maximum APK compression.
DSH_XZ_PRESET="${DSH_XZ_PRESET:-0}"
PNPM_TGZ="$CACHE_DIR/pnpm-$PNPM_VERSION.tgz"
PNPM_URL="https://registry.npmjs.org/pnpm/-/pnpm-$PNPM_VERSION.tgz"

printf '[DSH] Java: '
java -version 2>&1 | head -n 1 || true
printf '[DSH] SDK: %s\n' "$SDK"
printf '[DSH] Gradle home: %s\n' "$GRADLE_USER_HOME"

if ! command -v java >/dev/null 2>&1; then
  echo '[DSH] 缺少 Java。执行: pkg install openjdk-17 -y'
  exit 2
fi
if ! command -v curl >/dev/null 2>&1 || ! command -v unzip >/dev/null 2>&1 || ! command -v tar >/dev/null 2>&1; then
  echo '[DSH] 缺少 curl/unzip/tar。执行: pkg install curl unzip tar -y'
  exit 2
fi
if ! command -v xz >/dev/null 2>&1; then
  echo '[DSH] 缺少 xz 解压器。Termux 包名是 xz-utils。'
  echo '[DSH] 执行: pkg install xz-utils -y'
  exit 2
fi
if ! command -v aapt2 >/dev/null 2>&1; then
  echo '[DSH] 缺少 Termux ARM aapt2。执行: pkg install aapt2 -y'
  exit 2
fi
if [ ! -f "$SDK/platforms/android-36/android.jar" ]; then
  echo "[DSH] 缺少 Android SDK Platform 36: $SDK/platforms/android-36/android.jar"
  echo '[DSH] 请先安装 Android SDK 36 后重新运行。'
  exit 3
fi

snapshot_valid() {
  [ -s "$SNAPSHOT" ] || return 1
  # Do not use `printf ... | grep -q` under `set -o pipefail`: grep -q exits
  # as soon as it finds a match, which can SIGPIPE the producer and turn a
  # successful match into pipeline status 141. Read the full archive listing
  # once and let awk decide at EOF, so pipefail only reports real tar/xz errors.
  tar -tJf "$SNAPSHOT" 2>/dev/null \
    | sed 's#^\./##' \
    | awk '
      $0 == "usr/bin/node" { node = 1 }
      $0 == "usr/lib/node_modules/@deepseek-ai/dsh/lib/bin.js" { dsh = 1 }
      $0 == "usr/lib/libtermux-exec-ld-preload.so" { preload = 1 }
      END { exit !(node && dsh && preload) }
    '
}

apk_valid() {
  local apk="$1"
  [ -s "$apk" ] || return 1
  [ "$(sha256sum "$apk" | awk '{print $1}')" = "$RELEASE_APK_SHA256" ]
}

snapshot_has_pnpm() {
  tar -tJf "$SNAPSHOT" 2>/dev/null \
    | sed 's#^\./##' \
    | awk '
      $0 == "usr/lib/node_modules/pnpm/bin/pnpm.cjs" { module = 1 }
      $0 == "usr/lib/node_modules/pnpm/bin/pnpm.mjs" { module = 1 }
      $0 == "usr/lib/node_modules/pnpm/bin/pnpm.js" { module = 1 }
      $0 == "usr/bin/pnpm" { wrapper = 1 }
      END { exit !(module && wrapper) }
    '
}

snapshot_has_npm_runtime() {
  tar -tJf "$SNAPSHOT" 2>/dev/null \
    | sed 's#^\./##' \
    | awk '
      $0 == "usr/bin/npm" { npm = 1 }
      $0 == "usr/bin/npx" { npx = 1 }
      $0 == "usr/lib/node_modules/npm/bin/npm-cli.js" { cli = 1 }
      END { exit !(npm && npx && cli) }
    '
}

normalize_snapshot_symlinks() {
  local stage="$1"
  local legacy_prefix="/data/data/com.termux/files/usr"
  local link target mapped relative

  while IFS= read -r -d '' link; do
    target="$(readlink "$link")"
    case "$target" in
      "$legacy_prefix"/*)
        mapped="$stage/usr/${target#"$legacy_prefix"/}"
        relative="$(realpath -m --relative-to="$(dirname "$link")" "$mapped")"
        rm -f -- "$link"
        ln -s "$relative" "$link"
        ;;
      /system/bin/sh)
        # Exact Android system-shell target is intentionally supported.
        ;;
      /*)
        echo "[DSH] Refusing snapshot absolute symlink: ${link#"$stage"/} -> $target" >&2
        return 4
        ;;
    esac
  done < <(find "$stage" -type l -print0)

  # Build-time invariant: no Termux-prefix absolute links may survive into the
  # APK. Android extraction also contains a relocation fallback, but a clean
  # archive is the primary defense against first-run extraction failures.
  local survivor=""
  while IFS= read -r -d '' link; do
    target="$(readlink "$link")"
    case "$target" in
      "$legacy_prefix"/*) survivor="${link#"$stage"/} -> $target"; break ;;
    esac
  done < <(find "$stage" -type l -print0)
  if [ -n "$survivor" ]; then
    echo "[DSH] legacy Termux absolute symlink survived normalization: $survivor" >&2
    return 4
  fi
}

# Repack every top-level snapshot tree, not just usr/. Some upstream/mobile
# snapshots seed HOME with profile/default files; dropping home/ during a pnpm
# or DSH refresh silently changes first-launch behaviour.
repack_snapshot_stage() {
  local stage="$1" out="$2"
  local entries=()
  while IFS= read -r -d '' item; do
    entries+=("${item#./}")
  done < <(cd "$stage" && find . -mindepth 1 -maxdepth 1 -print0)
  [ "${#entries[@]}" -gt 0 ] || { echo '[DSH] staging snapshot is empty.'; exit 4; }
  normalize_snapshot_symlinks "$stage"
  # xz preset 0 uses a much smaller dictionary than the default preset 6,
  # reducing Android-side decompression CPU/memory at the cost of a larger APK.
  # Override DSH_XZ_PRESET if distribution size matters more than first launch.
  (cd "$stage" && XZ_OPT="-$DSH_XZ_PRESET" tar -cJf "$out" "${entries[@]}")
}

# Older dsh-mobile snapshots were built for the Web Host and may omit pnpm.
# Desktop DSH ships its own package manager; Android must do the same or
# `dsh plugin --profile web add ...` cannot be standalone. Inject a pinned
# pnpm distribution into the verified official runtime only when needed.
ensure_pnpm_runtime() {
  snapshot_has_pnpm && return 0
  echo "[DSH] Runtime 未包含完整 pnpm，注入 pnpm $PNPM_VERSION（插件管理必需）…"
  local stage="$CACHE_DIR/runtime-patch-v0110"
  rm -rf "$stage"
  mkdir -p "$stage" "$(dirname "$PNPM_TGZ")"
  tar -xJf "$SNAPSHOT" -C "$stage"
  if [ ! -s "$PNPM_TGZ" ]; then
    curl -L --fail --retry 3 --connect-timeout 20 -o "$PNPM_TGZ.part" "$PNPM_URL"
    mv "$PNPM_TGZ.part" "$PNPM_TGZ"
  fi
  mkdir -p "$stage/usr/lib/node_modules/pnpm"
  tar -xzf "$PNPM_TGZ" -C "$stage/usr/lib/node_modules/pnpm" --strip-components=1
  if [ ! -f "$stage/usr/lib/node_modules/pnpm/bin/pnpm.cjs" ] && \
     [ ! -f "$stage/usr/lib/node_modules/pnpm/bin/pnpm.mjs" ] && \
     [ ! -f "$stage/usr/lib/node_modules/pnpm/bin/pnpm.js" ]; then
    echo '[DSH] pnpm 包结构异常，停止构建。'
    exit 4
  fi
  # npm --global creates usr/bin/pnpm as a symlink into the pnpm package.
  # Never redirect into that symlink: doing `cat > usr/bin/pnpm` follows it
  # and overwrites pnpm/bin/pnpm.mjs with shell text, which later crashes as
  # `SyntaxError: Unexpected string`. Remove the links first and create real
  # Android wrappers.
  rm -f "$stage/usr/bin/pnpm" "$stage/usr/bin/pnpx"
  cat > "$stage/usr/bin/pnpm" <<'EOF'
#!/system/bin/sh
for ENTRY in \
  "$TERMUX__PREFIX/lib/node_modules/pnpm/bin/pnpm.cjs" \
  "$TERMUX__PREFIX/lib/node_modules/pnpm/bin/pnpm.mjs" \
  "$TERMUX__PREFIX/lib/node_modules/pnpm/bin/pnpm.js"; do
  [ -f "$ENTRY" ] && exec "$TERMUX__PREFIX/bin/node" "$ENTRY" "$@"
done
echo "pnpm entrypoint missing" >&2
exit 127
EOF
  chmod 0755 "$stage/usr/bin/pnpm"
  cat > "$stage/usr/bin/pnpx" <<'EOF'
#!/system/bin/sh
for ENTRY in \
  "$TERMUX__PREFIX/lib/node_modules/pnpm/bin/pnpx.cjs" \
  "$TERMUX__PREFIX/lib/node_modules/pnpm/bin/pnpx.mjs" \
  "$TERMUX__PREFIX/lib/node_modules/pnpm/bin/pnpx.js"; do
  [ -f "$ENTRY" ] && exec "$TERMUX__PREFIX/bin/node" "$ENTRY" "$@"
done
exec "$TERMUX__PREFIX/bin/pnpm" dlx "$@"
EOF
  chmod 0755 "$stage/usr/bin/pnpx"
  validate_pnpm_runtime "$stage"
  local rebuilt="$CACHE_DIR/snapshot-v0110-pnpm.tar.xz"
  rm -f "$rebuilt"
  repack_snapshot_stage "$stage" "$rebuilt"
  cp "$rebuilt" "$SNAPSHOT"
  rm -rf "$stage"
  snapshot_has_pnpm || { echo '[DSH] pnpm 注入后校验失败。'; exit 4; }
}

snapshot_dsh_version() {
  tar -xOJf "$SNAPSHOT" usr/lib/node_modules/@deepseek-ai/dsh/package.json 2>/dev/null \
    | sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' \
    | head -n 1
}

write_runtime_pnpm_wrappers() {
  local stage="$1"
  # npm --global creates usr/bin/pnpm as a symlink into the pnpm package.
  # Never redirect into that symlink: doing `cat > usr/bin/pnpm` follows it
  # and overwrites pnpm/bin/pnpm.mjs with shell text, which later crashes as
  # `SyntaxError: Unexpected string`. Remove the links first and create real
  # Android wrappers.
  rm -f "$stage/usr/bin/pnpm" "$stage/usr/bin/pnpx"
  cat > "$stage/usr/bin/pnpm" <<'EOF'
#!/system/bin/sh
for ENTRY in \
  "$TERMUX__PREFIX/lib/node_modules/pnpm/bin/pnpm.cjs" \
  "$TERMUX__PREFIX/lib/node_modules/pnpm/bin/pnpm.mjs" \
  "$TERMUX__PREFIX/lib/node_modules/pnpm/bin/pnpm.js"; do
  [ -f "$ENTRY" ] && exec "$TERMUX__PREFIX/bin/node" "$ENTRY" "$@"
done
echo "pnpm entrypoint missing" >&2
exit 127
EOF
  chmod 0755 "$stage/usr/bin/pnpm"
  cat > "$stage/usr/bin/pnpx" <<'EOF'
#!/system/bin/sh
for ENTRY in \
  "$TERMUX__PREFIX/lib/node_modules/pnpm/bin/pnpx.cjs" \
  "$TERMUX__PREFIX/lib/node_modules/pnpm/bin/pnpx.mjs" \
  "$TERMUX__PREFIX/lib/node_modules/pnpm/bin/pnpx.js"; do
  [ -f "$ENTRY" ] && exec "$TERMUX__PREFIX/bin/node" "$ENTRY" "$@"
done
exec "$TERMUX__PREFIX/bin/pnpm" dlx "$@"
EOF
  chmod 0755 "$stage/usr/bin/pnpx"
}

validate_pnpm_runtime() {
  local stage="$1" entry=''
  for candidate in \
    "$stage/usr/lib/node_modules/pnpm/bin/pnpm.cjs" \
    "$stage/usr/lib/node_modules/pnpm/bin/pnpm.mjs" \
    "$stage/usr/lib/node_modules/pnpm/bin/pnpm.js"; do
    if [ -f "$candidate" ]; then entry="$candidate"; break; fi
  done
  [ -n "$entry" ] || { echo '[DSH] pnpm entrypoint missing after install.'; exit 4; }
  if grep -aq '^#!/system/bin/sh$\|^ENTRY=' "$entry" 2>/dev/null; then
    echo "[DSH] pnpm entrypoint was corrupted by a shell wrapper: $entry"
    exit 4
  fi
  LD_LIBRARY_PATH="$stage/usr/lib" "$stage/usr/bin/node" --check "$entry" >/dev/null 2>&1 || {
    echo "[DSH] pnpm JavaScript syntax validation failed: $entry"
    exit 4
  }
  echo '[DSH] pnpm runtime: OK'
}

# Latest-runtime mode: retain the proven Android/Termux filesystem shell from
# the base snapshot, but replace Node + the published DSH graph with the build
# host's current Termux Node and the pinned upstream DSH. Native dependencies
# are built explicitly after an --ignore-scripts install so Android-only fixes
# can be applied deterministically.
check_host_node() {
  if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
    echo '[DSH] 最新 DSH runtime 需要 Node/npm。执行: pkg install nodejs-lts -y'
    exit 2
  fi
  node - <<'NODE'
const [major, minor] = process.versions.node.split('.').map(Number)
if (!((major === 22 && minor >= 19) || (major === 24 && minor >= 2) || major >= 25)) {
  console.error(`[DSH] DSH runtime requires Node 22.19+ or Node 24.2+ in practice; current build host is ${process.versions.node}`)
  process.exit(2)
}
if (process.platform !== 'android') {
  console.error(`[DSH] This runtime builder must run inside Termux/Android; process.platform=${process.platform}`)
  process.exit(2)
}
if (process.arch !== 'arm64') {
  console.error(`[DSH] Current APK runtime is arm64; build host arch=${process.arch}`)
  process.exit(2)
}
NODE
}

check_native_toolchain() {
  [ "$DSH_NATIVE_COMPAT" = "1" ] || return 0
  local missing=()
  for cmd in clang clang++ cmake ninja make python pkg-config; do
    command -v "$cmd" >/dev/null 2>&1 || missing+=("$cmd")
  done
  if [ "${#missing[@]}" -gt 0 ]; then
    echo "[DSH] 缺少 Android 原生模块构建工具: ${missing[*]}"
    echo '[DSH] 执行: pkg install clang cmake ninja make python binutils pkg-config libandroid-spawn -y'
    echo '[DSH] 为避免生成 node-pty/koffi 缺失的残缺 APK，本次停止。'
    exit 2
  fi
}

check_git_toolchain() {
  [ "$DSH_GIT_COMPAT" = "1" ] || return 0
  local missing=()
  for cmd in git ssh ssh-keygen ssh-keyscan; do
    command -v "$cmd" >/dev/null 2>&1 || missing+=("$cmd")
  done
  local host_prefix="${PREFIX:-/data/data/com.termux/files/usr}"
  local cert_found=0
  for cert in \
    "$host_prefix/etc/tls/cert.pem" \
    "$host_prefix/etc/ssl/certs/ca-certificates.crt" \
    "$host_prefix/etc/tls/certs/ca-certificates.crt"; do
    [ -s "$cert" ] && cert_found=1 && break
  done
  if [ "${#missing[@]}" -gt 0 ] || [ "$cert_found" != "1" ]; then
    echo "[DSH] Git/SSH/CA runtime 依赖不完整。缺少命令: ${missing[*]:-无}"
    [ "$cert_found" = "1" ] || echo '[DSH] 未检测到 CA certificate bundle。'
    echo '[DSH] 执行: pkg install git openssh ca-certificates -y'
    echo '[DSH] 为避免打包只能安装 npm/tarball、不能安装 Git/GitHub 插件的残缺 runtime，本次停止。'
    exit 2
  fi
}

prepare_node_headers() {
  local host_prefix="${PREFIX:-/data/data/com.termux/files/usr}"
  local ver headers common
  ver="$(node -p 'process.versions.node')"
  headers="$CACHE_DIR/node-headers-$ver"
  common="$headers/include/node/common.gypi"
  rm -rf "$headers"
  mkdir -p "$headers/include"
  if [ ! -d "$host_prefix/include/node" ]; then
    echo "[DSH] Termux Node headers not found: $host_prefix/include/node"
    exit 7
  fi
  cp -RL --preserve=mode,timestamps "$host_prefix/include/node" "$headers/include/node"
  if [ -f "$common" ]; then
    python - "$common" <<'PY2'
from pathlib import Path
import sys
p=Path(sys.argv[1]); s=p.read_text()
mark="'android_ndk_path%': '',  # DSH Android compat"
if mark not in s:
    needle="'variables': {"
    if needle not in s:
        raise SystemExit('common.gypi variables anchor missing')
    s=s.replace(needle, needle+"\n    "+mark, 1)
    p.write_text(s)
PY2
  fi
  printf '%s\n' "$headers"
}

copy_link_deps() {
  local file="$1" dest="$2" host_prefix="${PREFIX:-/data/data/com.termux/files/usr}"
  [ -f "$file" ] || return 0
  mkdir -p "$dest"

  # Resolve the complete ELF NEEDED closure instead of trusting ldd's printed
  # paths. Termux binaries may carry a RUNPATH back to the build host; a staging
  # smoke test can therefore succeed while the APK is missing a transitive
  # library (for example Git -> libpcre2-8.so) on the real device.
  local readelf_bin=''
  if command -v readelf >/dev/null 2>&1; then
    readelf_bin="$(command -v readelf)"
  elif command -v llvm-readelf >/dev/null 2>&1; then
    readelf_bin="$(command -v llvm-readelf)"
  fi

  if [ -n "$readelf_bin" ]; then
    local queue="$CACHE_DIR/.elfdeps-${BASHPID:-$}-$RANDOM.queue"
    local seen="$CACHE_DIR/.elfdeps-${BASHPID:-$}-$RANDOM.seen"
    : > "$queue"; : > "$seen"
    printf '%s\n' "$file" >> "$queue"
    while IFS= read -r current; do
      [ -f "$current" ] || continue
      grep -Fxq "$current" "$seen" 2>/dev/null && continue
      printf '%s\n' "$current" >> "$seen"

      # copy_link_deps is also called for package-owned shell/Perl wrappers
      # such as Termux 'pkg'. readelf legitimately returns non-zero for those
      # files. Under set -o pipefail that used to abort the entire build after
      # the package overlay finished. Treat non-ELF inputs as having no DT_NEEDED
      # entries instead of turning that normal condition into a fatal error.
      { "$readelf_bin" -d "$current" 2>/dev/null || true; } \
        | sed -n 's/.*Shared library: \[\([^]]*\)\].*/\1/p' \
        | while IFS= read -r soname; do
            [ -n "$soname" ] || continue
            case "$soname" in
              libc.so|libdl.so|libm.so|liblog.so|libandroid.so) continue ;;
            esac
            local_path=''
            if [ -f "$host_prefix/lib/$soname" ]; then
              local_path="$host_prefix/lib/$soname"
            else
              local_path="$(find "$host_prefix/lib" -maxdepth 3 -type f -name "$soname" -print -quit 2>/dev/null || true)"
            fi
            [ -n "$local_path" ] || continue
            cp -Lf "$local_path" "$dest/$soname"
            printf '%s\n' "$local_path" >> "$queue"
          done
    done < "$queue"
    rm -f "$queue" "$seen"
  fi

  # Keep ldd as a secondary compatibility path for unusual linker output.
  if command -v ldd >/dev/null 2>&1; then
    local listing
    listing="$(ldd "$file" 2>/dev/null || true)"
    printf '%s\n' "$listing" | awk '
      /=> \/data\// { print $3 }
      /^\/data\// { print $1 }
    ' | while IFS= read -r lib; do
      [ -f "$lib" ] || continue
      case "$lib" in
        "$host_prefix"/lib/*) cp -Lf "$lib" "$dest/" || true ;;
      esac
    done
  fi
}

. "$ROOT/scripts/embed-termux-tools.sh"

install_terminal_shell_runtime() {
  local stage="$1" host_bash host_prefix real_bash
  host_bash="$(command -v bash 2>/dev/null || true)"
  host_prefix="${PREFIX:-/data/data/com.termux/files/usr}"
  [ -n "$host_bash" ] && [ -x "$host_bash" ] || {
    echo '[DSH] Termux bash is required for the embedded interactive terminal.'
    exit 7
  }

  mkdir -p "$stage/usr/bin" "$stage/usr/libexec/dsh" "$stage/usr/etc"
  real_bash="$stage/usr/libexec/dsh/bash-real"
  cp -Lf "$host_bash" "$real_bash"
  chmod 0755 "$real_bash"
  copy_link_deps "$host_bash" "$stage/usr/lib"

  # Do not expose Termux's build-host absolute prefix through Bash's compiled
  # startup-file paths. A tiny Android-system-shell trampoline enters the real
  # embedded Bash with profile loading disabled; the sidebar may still pass
  # its normal -l argument and users receive an actual Bash process.
  rm -f "$stage/usr/bin/bash"
  cat > "$stage/usr/bin/bash" <<'EOF'
#!/system/bin/sh
REAL="$TERMUX__PREFIX/libexec/dsh/bash-real"
if [ ! -x "$REAL" ]; then
  echo "embedded bash runtime missing: $REAL" >&2
  exit 127
fi
exec "$REAL" --noprofile --norc "$@"
EOF
  chmod 0755 "$stage/usr/bin/bash"

  # Keep a stable POSIX shell name in the embedded PATH as well. Package
  # scripts with #!/usr/bin/env sh should never depend on an absolute symlink
  # surviving snapshot extraction.
  rm -f "$stage/usr/bin/sh"
  cat > "$stage/usr/bin/sh" <<'EOF'
#!/system/bin/sh
exec /system/bin/sh "$@"
EOF
  chmod 0755 "$stage/usr/bin/sh"

  if [ -f "$host_prefix/etc/inputrc" ]; then
    cp -Lf "$host_prefix/etc/inputrc" "$stage/usr/etc/inputrc"
  else
    cat > "$stage/usr/etc/inputrc" <<'EOF'
set editing-mode emacs
set completion-ignore-case on
EOF
  fi
}

validate_terminal_runtime() {
  local stage="$1"
  local node_pty_manifest node_pty_dir smoke_home preload=''
  [ -x "$stage/usr/bin/bash" ] || { echo '[DSH] Embedded terminal shell missing.'; exit 7; }
  [ -x "$stage/usr/libexec/dsh/bash-real" ] || { echo '[DSH] Embedded real Bash missing.'; exit 7; }

  smoke_home="$CACHE_DIR/terminal-smoke-home"
  rm -rf "$smoke_home"; mkdir -p "$smoke_home/tmp"

  # First prove the shell itself runs with the same relocation variables used
  # by the APK.
  if ! env     PATH="$stage/usr/bin:/system/bin"     LD_LIBRARY_PATH="$stage/usr/lib"     HOME="$smoke_home"     TMPDIR="$smoke_home/tmp"     TERMUX__PREFIX="$stage/usr"     TERMUX__ROOTFS="$stage"     SHELL="$stage/usr/bin/bash"     "$stage/usr/bin/bash" -lc 'printf "__DSH_BASH_OK__"' 2>/dev/null       | grep -Fq '__DSH_BASH_OK__'; then
    echo '[DSH] Embedded Bash relocation smoke test failed.'
    exit 7
  fi

  # Then prove node-pty can create a real PTY and execute that shell. Merely
  # require()'ing node-pty is insufficient: Android failures often appear only
  # at forkpty/spawn time.
  node_pty_manifest="$(find "$stage/usr/lib/node_modules" -type f -path '*/node-pty/package.json' -print -quit 2>/dev/null || true)"
  [ -n "$node_pty_manifest" ] || { echo '[DSH] node-pty missing for terminal smoke test.'; exit 7; }
  node_pty_dir="${node_pty_manifest%/package.json}"
  [ -f "$stage/usr/lib/libtermux-exec-ld-preload.so" ] && preload="$stage/usr/lib/libtermux-exec-ld-preload.so"

  if ! env     PATH="$stage/usr/bin:/system/bin"     LD_LIBRARY_PATH="$stage/usr/lib"     LD_PRELOAD="$preload"     HOME="$smoke_home"     TMPDIR="$smoke_home/tmp"     TERM=xterm-256color     TERMUX_EXEC__SYSTEM_LINKER_EXEC__MODE=force     TERMUX_EXEC__EXECVE_CALL__INTERCEPT=1     TERMUX__PREFIX="$stage/usr"     TERMUX__ROOTFS="$stage"     SHELL="$stage/usr/bin/bash"     DSH_SIDEBAR_SHELL="$stage/usr/bin/bash"     "$stage/usr/bin/node" - "$node_pty_dir" "$stage/usr/bin/bash" "$smoke_home" <<'NODE'
const ptyRoot = process.argv[2]
const shell = process.argv[3]
const cwd = process.argv[4]
let pty
try {
  pty = require(ptyRoot)
} catch (error) {
  console.error(error && error.stack || error)
  process.exit(1)
}
const child = pty.spawn(shell, ['-lc', 'printf "__DSH_PTY_OK__"; exit'], {
  name: 'xterm-256color',
  cols: 80,
  rows: 24,
  cwd,
  env: { ...process.env, SHELL: shell, DSH_SIDEBAR_SHELL: shell },
})
let output = ''
const timer = setTimeout(() => {
  try { child.kill() } catch {}
  console.error('node-pty terminal smoke timeout')
  process.exit(2)
}, 8000)
child.onData(data => { output += data })
child.onExit(() => {
  clearTimeout(timer)
  if (!output.includes('__DSH_PTY_OK__')) {
    console.error(output)
    process.exit(3)
  }
  process.stdout.write('__DSH_PTY_OK__\n')
  process.exit(0)
})
NODE
  then
    echo '[DSH] Embedded node-pty + Bash spawn smoke test failed.'
    exit 7
  fi

  echo '[DSH] Interactive terminal runtime: OK (Bash + node-pty spawn)'
}

overlay_host_node_runtime() {
  local stage="$1" host_node host_prefix
  host_node="$(command -v node)"
  host_prefix="${PREFIX:-/data/data/com.termux/files/usr}"
  mkdir -p "$stage/usr/bin" "$stage/usr/lib"
  cp -Lf "$host_node" "$stage/usr/bin/node"
  chmod 0755 "$stage/usr/bin/node"
  copy_link_deps "$host_node" "$stage/usr/lib"
  # Common Termux C++/spawn dependencies are cheap insurance for node-pty/koffi.
  for glob in "$host_prefix"/lib/libc++_shared.so "$host_prefix"/lib/libandroid-spawn.so*; do
    for lib in $glob; do [ -f "$lib" ] && cp -Lf "$lib" "$stage/usr/lib/" || true; done
  done
  local embedded
  embedded="$(LD_LIBRARY_PATH="$stage/usr/lib" "$stage/usr/bin/node" -p 'process.versions.node' 2>/dev/null || true)"
  [ -n "$embedded" ] || { echo '[DSH] 覆盖新版 Node 后无法在 staging 环境启动。'; exit 7; }
  echo "[DSH] Embedded Node -> $embedded"
}

validate_reusable_node_pty() {
  local stage="$1" manifest dir
  manifest="$(find "$stage/usr/lib/node_modules" -type f -path '*/node-pty/package.json' -print -quit 2>/dev/null || true)"
  [ -n "$manifest" ] || {
    echo '[DSH] Embedded node-pty package is missing; Android community plugins would fall back to node-gyp on-device.'
    exit 7
  }
  dir="${manifest%/package.json}"
  if ! LD_LIBRARY_PATH="$stage/usr/lib" "$stage/usr/bin/node" -e     'const root=process.argv[1]; try { require(root) } catch (e) { console.error(e && e.stack || e); process.exit(1) }'     "$dir" >/dev/null 2>&1; then
    echo "[DSH] Embedded node-pty is not loadable by the exact bundled Node: $dir"
    exit 7
  fi
  echo "[DSH] Reusable node-pty runtime: OK -> $dir"
}

copy_native_module_deps() {
  local stage="$1"
  find "$stage/usr/lib/node_modules" -type f -name '*.node' -print0 2>/dev/null \
    | while IFS= read -r -d '' addon; do copy_link_deps "$addon" "$stage/usr/lib"; done
}

build_native_modules() {
  local stage="$1" node_headers="$2"
  [ "$DSH_NATIVE_COMPAT" = "1" ] || { echo '[DSH] Native compatibility build disabled.'; return 0; }
  local target='aarch64-linux-android30'
  local flags="-target $target"
  local found_pty=0 pty_failed=0 found_koffi=0 koffi_failed=0

  while IFS= read -r -d '' manifest; do
    local dir
    dir="${manifest%/package.json}"
    found_pty=1
    echo "[DSH] Building node-pty: $dir"
    rm -rf "$dir/build"
    if ! (cd "$dir" && \
      env npm_config_nodedir="$node_headers" GYP_DEFINES="android_ndk_path=''" \
        CC=clang CXX=clang++ CFLAGS="$flags" CXXFLAGS="$flags" \
        npm run install --if-present); then
      pty_failed=1
      continue
    fi
    if ! find "$dir" -type f -name 'pty.node' -print -quit | grep -q .; then
      echo "[DSH] node-pty build returned success but pty.node is missing: $dir"
      pty_failed=1
    fi
  done < <(find "$stage/usr/lib/node_modules" -type f -path '*/node-pty/package.json' -print0 2>/dev/null)

  while IFS= read -r -d '' manifest; do
    local dir koffi_probe koffi_probe_status
    dir="${manifest%/package.json}"
    found_koffi=1

    # Koffi >= 3.2.1 can keep the Android addon in a sibling optional package
    # such as @koromix/koffi-android-arm64 rather than under koffi/ itself.
    # Therefore a find(1) for "$dir/*.node" is not a valid health check.  The
    # only reliable criterion is whether the exact embedded Node can require
    # this Koffi installation with the staged Android libraries.
    koffi_probe="$(LD_LIBRARY_PATH="$stage/usr/lib" "$stage/usr/bin/node" -e '
      const root = process.argv[1]
      try {
        require(root)
        const addons = Object.keys(require.cache).filter(p => p.endsWith(".node") && /koffi/i.test(p))
        if (addons.length === 0) throw new Error("koffi loaded without a native .node entry in require.cache")
        process.stdout.write(addons.at(-1))
      } catch (error) {
        console.error(error && error.stack || error)
        process.exit(1)
      }
    ' "$dir" 2>&1)" && koffi_probe_status=0 || koffi_probe_status=$?

    if [ "$koffi_probe_status" = "0" ]; then
      echo "[DSH] koffi Android prebuilt/native load: OK -> $koffi_probe"
      continue
    fi

    echo "[DSH] Koffi prebuilt is not loadable; building from source for API 30: $dir"
    printf '%s\n' "$koffi_probe" | tail -n 12 || true
    rm -rf "$dir/build"
    if ! (cd "$dir" && \
      env CC=clang CXX=clang++ CFLAGS="$flags" CXXFLAGS="$flags" \
        CMAKE_C_FLAGS="$flags" CMAKE_CXX_FLAGS="$flags" CMAKE_BUILD_PARALLEL_LEVEL="${CMAKE_BUILD_PARALLEL_LEVEL:-2}" \
        npm run install --if-present); then
      echo "[DSH] koffi Android source build failed: $dir"
      koffi_failed=1
      continue
    fi

    koffi_probe="$(LD_LIBRARY_PATH="$stage/usr/lib" "$stage/usr/bin/node" -e '
      const root = process.argv[1]
      try {
        require(root)
        const addons = Object.keys(require.cache).filter(p => p.endsWith(".node") && /koffi/i.test(p))
        if (addons.length === 0) throw new Error("koffi loaded without a native .node entry in require.cache")
        process.stdout.write(addons.at(-1))
      } catch (error) {
        console.error(error && error.stack || error)
        process.exit(1)
      }
    ' "$dir" 2>&1)" && koffi_probe_status=0 || koffi_probe_status=$?
    if [ "$koffi_probe_status" != "0" ]; then
      echo "[DSH] koffi Android source build/load failed: $dir"
      printf '%s\n' "$koffi_probe" | tail -n 20 || true
      koffi_failed=1
    else
      echo "[DSH] koffi Android source build/load: OK -> $koffi_probe"
    fi
  done < <(find "$stage/usr/lib/node_modules" -type f -path '*/koffi/package.json' -print0 2>/dev/null)

  copy_native_module_deps "$stage"

  # A file existing is not enough: ABI/linker failures only show up when Node
  # actually loads the addon. Smoke-test every installed instance.
  if [ "$found_pty" = "1" ]; then
    while IFS= read -r -d '' manifest; do
      local dir="${manifest%/package.json}"
      if ! LD_LIBRARY_PATH="$stage/usr/lib" "$stage/usr/bin/node" -e \
        'try { require(process.argv[1]); } catch (e) { console.error(e && e.stack || e); process.exit(1) }' "$dir" >/dev/null 2>&1; then
        echo "[DSH] node-pty require() smoke test failed: $dir"
        pty_failed=1
      fi
    done < <(find "$stage/usr/lib/node_modules" -type f -path '*/node-pty/package.json' -print0 2>/dev/null)
  fi

  if [ "$found_pty" = "1" ] && [ "$pty_failed" != "0" ]; then
    echo '[DSH] node-pty Android 编译/加载校验失败；Terminal/Subprocess 会导致 DSH 启动或功能异常。'
    [ "$DSH_ALLOW_DEGRADED" = "1" ] || exit 7
  fi
  if [ "$found_koffi" = "1" ] && [ "$koffi_failed" != "0" ]; then
    echo '[DSH] koffi Android 编译/加载校验失败；拒绝把不可加载的原生模块打进 APK。'
    [ "$DSH_ALLOW_DEGRADED" = "1" ] || exit 7
  fi
}

install_sharp_wasm() {
  local stage="$1" registry="$2" manifest version
  manifest="$(find "$stage/usr/lib/node_modules" -type f -path '*/sharp/package.json' -print -quit 2>/dev/null || true)"
  [ -n "$manifest" ] || { echo '[DSH] sharp 未安装，跳过 WASM fallback。'; return 0; }
  version="$(node -e 'const fs=require("fs");console.log(JSON.parse(fs.readFileSync(process.argv[1],"utf8")).version)' "$manifest")"
  echo "[DSH] Installing sharp WASM fallback -> @img/sharp-wasm32@$version"
  if ! npm install --global --prefix "$stage/usr" --ignore-scripts --no-audit --no-fund --prefer-offline \
      --registry="$registry" --fetch-retries=5 --fetch-retry-mintimeout=20000 --fetch-retry-maxtimeout=120000 \
      "@img/sharp-wasm32@$version"; then
    echo '[DSH] sharp WASM fallback 安装失败。'
    [ "$DSH_ALLOW_DEGRADED" = "1" ] || exit 7
  fi
}

copy_host_npm_runtime() {
  local stage="$1" host_prefix="${PREFIX:-/data/data/com.termux/files/usr}"
  local host_npm="$host_prefix/lib/node_modules/npm"
  if [ ! -f "$host_npm/bin/npm-cli.js" ]; then
    echo "[DSH] Termux npm runtime missing: $host_npm"
    exit 7
  fi
  echo '[DSH] Bundling npm/npx compatibility runtime…'
  rm -rf "$stage/usr/lib/node_modules/npm"
  mkdir -p "$stage/usr/lib/node_modules" "$stage/usr/bin"
  # Do not preserve hard-link topology: some Android filesystems reject link().
  cp -RL --preserve=mode,timestamps "$host_npm" "$stage/usr/lib/node_modules/npm"
  rm -f "$stage/usr/bin/npm" "$stage/usr/bin/npx"
  cat > "$stage/usr/bin/npm" <<'EOF_NPM'
#!/system/bin/sh
exec "$TERMUX__PREFIX/bin/node" "$TERMUX__PREFIX/lib/node_modules/npm/bin/npm-cli.js" "$@"
EOF_NPM
  cat > "$stage/usr/bin/npx" <<'EOF_NPX'
#!/system/bin/sh
exec "$TERMUX__PREFIX/bin/node" "$TERMUX__PREFIX/lib/node_modules/npm/bin/npx-cli.js" "$@"
EOF_NPX
  chmod 0755 "$stage/usr/bin/npm" "$stage/usr/bin/npx"

  local env_prefix=(env \
    TERMUX__PREFIX="$stage/usr" \
    HOME="$stage/home" \
    PATH="$stage/usr/bin:/system/bin" \
    LD_LIBRARY_PATH="$stage/usr/lib")
  "$stage/usr/bin/node" --check "$stage/usr/lib/node_modules/npm/bin/npm-cli.js" >/dev/null
  "${env_prefix[@]}" "$stage/usr/bin/npm" --version >/dev/null 2>&1 || {
    echo '[DSH] Embedded npm smoke test failed.'; exit 7;
  }
  "${env_prefix[@]}" "$stage/usr/bin/npx" --version >/dev/null 2>&1 || {
    echo '[DSH] Embedded npx smoke test failed.'; exit 7;
  }
  echo '[DSH] npm/npx runtime: OK'
}

copy_ripgrep_runtime() {
  local stage="$1"
  if command -v rg >/dev/null 2>&1; then
    cp -Lf "$(command -v rg)" "$stage/usr/bin/rg"
    chmod 0755 "$stage/usr/bin/rg"
    copy_link_deps "$(command -v rg)" "$stage/usr/lib"
    echo '[DSH] ripgrep runtime: OK'
  else
    echo '[DSH] 警告：未安装 ripgrep；文件 grep/glob 可能降级。推荐: pkg install ripgrep -y'
  fi
}

validate_ripgrep_runtime() {
  local stage="$1"
  local rg="$stage/usr/bin/rg"
  [ -x "$rg" ] || { echo '[DSH] ripgrep runtime missing; install Termux ripgrep before building.'; exit 7; }
  env LD_LIBRARY_PATH="$stage/usr/lib" "$rg" --version >/dev/null 2>&1 || {
    echo '[DSH] embedded ripgrep executable smoke test failed.'; exit 7;
  }

  local resolver found=0
  while IFS= read -r resolver; do
    [ -n "$resolver" ] || continue
    found=1
    if ! env       LD_LIBRARY_PATH="$stage/usr/lib"       DSH_RG_PATH="$rg"       DSH_RIPGREP_RESOLVER="$resolver"       "$stage/usr/bin/node" --input-type=module -e '
        import { pathToFileURL } from "node:url";
        const mod = await import(pathToFileURL(process.env.DSH_RIPGREP_RESOLVER).href);
        const actual = mod.rgPath ?? mod.default?.rgPath;
        if (actual !== process.env.DSH_RG_PATH) {
          console.error(`resolver returned ${String(actual)} instead of ${process.env.DSH_RG_PATH}`);
          process.exit(1);
        }
      ' >/dev/null 2>&1; then
      echo "[DSH] @vscode/ripgrep Android resolver smoke test failed: $resolver"
      exit 7
    fi
  done < <(find "$stage/usr/lib/node_modules" -type f -path '*/@vscode/ripgrep/lib/index.js' -print 2>/dev/null)

  if [ "$found" -eq 0 ]; then
    # Some future DSH build may fully inline the helper.  In that case only
    # accept a runtime when our direct fs-search DSH_RG_PATH rewrite exists.
    if ! grep -Rqs 'DSH Android compat: external rg path' "$stage/usr/lib/node_modules" 2>/dev/null; then
      echo '[DSH] neither @vscode/ripgrep resolver nor fs-search DSH_RG_PATH override was found.'
      exit 7
    fi
    echo '[DSH] ripgrep resolver: direct fs-search override OK'
  else
    echo '[DSH] @vscode/ripgrep resolver -> embedded rg: OK'
  fi
}

copy_git_ssh_ca_runtime() {
  local stage="$1"
  [ "$DSH_GIT_COMPAT" = "1" ] || { echo '[DSH] Git/SSH compatibility runtime disabled.'; return 0; }

  local host_prefix="${PREFIX:-/data/data/com.termux/files/usr}"
  local git_bin ssh_bin git_exec cert_src
  git_bin="$(command -v git)"
  ssh_bin="$(command -v ssh)"
  git_exec="$(git --exec-path)"

  mkdir -p "$stage/usr/bin" "$stage/usr/lib" "$stage/usr/libexec/git-core" \
    "$stage/usr/share/git-core/templates" "$stage/usr/etc/tls" "$stage/usr/etc/ssl/certs" "$stage/usr/etc/ssh"

  cp -Lf "$git_bin" "$stage/usr/bin/git"
  chmod 0755 "$stage/usr/bin/git"
  copy_link_deps "$git_bin" "$stage/usr/lib"

  # Git's compiled-in Termux prefix is not valid inside the APK. Copy every
  # helper and force GIT_EXEC_PATH at runtime. Dereference symlinks so no
  # helper points back into /data/data/com.termux.
  if [ ! -d "$git_exec" ]; then
    echo "[DSH] Git exec path 不存在: $git_exec"
    exit 8
  fi
  # Do NOT use `cp -aL` here. GNU cp's -a implies --preserve=links;
  # combined with -L it can recreate dereferenced Git helper symlinks as hard
  # links. Some Android/Termux filesystems/SELinux policies reject those link()
  # calls even inside the build cache, producing "cannot create hard link ...
  # Permission denied". Copy helpers as independent regular files while keeping
  # executable mode/timestamps; runtime does not require inode sharing.
  cp -RL --preserve=mode,timestamps "$git_exec/." "$stage/usr/libexec/git-core/"
  find "$stage/usr/libexec/git-core" -maxdepth 1 -type f -print0 2>/dev/null | while IFS= read -r -d '' helper; do
    if head -n 1 "$helper" 2>/dev/null | grep -Fq "#!$host_prefix/bin/sh"; then
      sed -i "1s|^#!$host_prefix/bin/sh$|#!/system/bin/sh|" "$helper"
    fi
    [ -x "$helper" ] && copy_link_deps "$helper" "$stage/usr/lib" || true
  done

  if [ -d "$host_prefix/share/git-core/templates" ]; then
    cp -RL --preserve=mode,timestamps "$host_prefix/share/git-core/templates/." "$stage/usr/share/git-core/templates/"
  fi

  # SSH is required for git@github.com / ssh:// specs. Keep the useful client
  # tools so users can create/import keys and inspect host keys without Termux.
  for cmd in ssh ssh-keygen ssh-keyscan scp sftp; do
    if command -v "$cmd" >/dev/null 2>&1; then
      cp -Lf "$(command -v "$cmd")" "$stage/usr/bin/$cmd"
      chmod 0755 "$stage/usr/bin/$cmd"
      copy_link_deps "$(command -v "$cmd")" "$stage/usr/lib"
    fi
  done
  if command -v curl >/dev/null 2>&1; then
    cp -Lf "$(command -v curl)" "$stage/usr/bin/curl"
    chmod 0755 "$stage/usr/bin/curl"
    copy_link_deps "$(command -v curl)" "$stage/usr/lib"
  fi
  if command -v openssl >/dev/null 2>&1; then
    cp -Lf "$(command -v openssl)" "$stage/usr/bin/openssl"
    chmod 0755 "$stage/usr/bin/openssl"
    copy_link_deps "$(command -v openssl)" "$stage/usr/lib"
  fi

  cert_src=''
  for cert in \
    "$host_prefix/etc/tls/cert.pem" \
    "$host_prefix/etc/ssl/certs/ca-certificates.crt" \
    "$host_prefix/etc/tls/certs/ca-certificates.crt"; do
    if [ -s "$cert" ]; then cert_src="$cert"; break; fi
  done
  [ -n "$cert_src" ] || { echo '[DSH] CA bundle 丢失。'; exit 8; }
  cp -Lf "$cert_src" "$stage/usr/etc/tls/cert.pem"
  cp -Lf "$cert_src" "$stage/usr/etc/ssl/certs/ca-certificates.crt"

  cat > "$stage/usr/etc/ssh/ssh_config" <<'EOF_SSH'
Host *
    HashKnownHosts yes
    StrictHostKeyChecking accept-new
    ServerAliveInterval 30
    ServerAliveCountMax 3
    ConnectTimeout 30
EOF_SSH

  cat > "$stage/usr/etc/gitconfig" <<'EOF_GIT'
[safe]
    directory = *
[init]
    defaultBranch = main
[core]
    autocrlf = false
EOF_GIT

  # Local staging smoke tests catch missing copied libraries before the APK is
  # generated. Network access is deliberately not required here.
  local env_prefix=(
    env
    "LD_LIBRARY_PATH=$stage/usr/lib"
    "PATH=$stage/usr/bin:/system/bin"
    "HOME=$stage/home"
    "GIT_EXEC_PATH=$stage/usr/libexec/git-core"
    "GIT_TEMPLATE_DIR=$stage/usr/share/git-core/templates"
    "GIT_CONFIG_SYSTEM=$stage/usr/etc/gitconfig"
    "GIT_SSL_CAINFO=$stage/usr/etc/tls/cert.pem"
    "SSL_CERT_FILE=$stage/usr/etc/tls/cert.pem"
  )
  if readelf -d "$stage/usr/bin/git" 2>/dev/null | grep -Fq '[libpcre2-8.so]'; then
    [ -f "$stage/usr/lib/libpcre2-8.so" ] || { echo '[DSH] Git dependency libpcre2-8.so missing from embedded runtime.'; exit 8; }
  fi
  "${env_prefix[@]}" "$stage/usr/bin/git" --version >/dev/null 2>&1 || { echo '[DSH] Embedded git smoke test failed.'; exit 8; }
  "${env_prefix[@]}" "$stage/usr/bin/ssh" -V >/dev/null 2>&1 || { echo '[DSH] Embedded ssh smoke test failed.'; exit 8; }
  [ -f "$stage/usr/libexec/git-core/git-remote-https" ] || { echo '[DSH] git-remote-https helper missing.'; exit 8; }
  [ -s "$stage/usr/etc/tls/cert.pem" ] || { echo '[DSH] CA bundle copy failed.'; exit 8; }
  echo '[DSH] Git + SSH + CA runtime: OK'
}

snapshot_has_git_runtime() {
  tar -tJf "$SNAPSHOT" 2>/dev/null \
    | sed 's#^\./##' \
    | awk '
      $0 == "usr/bin/git" { git = 1 }
      $0 == "usr/libexec/git-core/git-remote-https" { https = 1 }
      $0 == "usr/bin/ssh" { ssh = 1 }
      $0 == "usr/etc/tls/cert.pem" { ca = 1 }
      END { exit !(git && https && ssh && ca) }
    '
}

apply_android_runtime_patches() {
  local stage="$1"
  echo '[DSH] Applying Android compatibility patches…'
  DSH_TARGET_VERSION="$DSH_VERSION" node "$ROOT/scripts/android-runtime-patch.mjs" "$stage/usr"
}

validate_dsh_core_plugin_tree() {
  local stage="$1"
  local smoke_home="$CACHE_DIR/core-plugin-tree-smoke-home"
  local smoke_log="$CACHE_DIR/core-plugin-tree-smoke.log"
  local port=$((39000 + RANDOM % 1500))
  local preload=""

  rm -rf "$smoke_home"
  mkdir -p "$smoke_home/tmp"
  if [ -d "$stage/home" ]; then
    cp -a "$stage/home/." "$smoke_home/"
  fi
  rm -rf "$smoke_home/.dsh/profiles/node_modules" \
         "$smoke_home/.dsh/profiles/web/node_modules" \
         "$smoke_home/.dsh/profiles/headless/node_modules"
  mkdir -p "$smoke_home/tmp"
  : > "$smoke_log"
  [ -f "$stage/usr/lib/libtermux-exec-ld-preload.so" ] && preload="$stage/usr/lib/libtermux-exec-ld-preload.so"

  echo '[DSH] Validating complete Cordis/core plugin tree with a real web boot…'
  env \
    PATH="$stage/usr/libexec/dsh/wrappers:$stage/usr/bin:/system/bin" \
    LD_LIBRARY_PATH="$stage/usr/lib" \
    LD_PRELOAD="$preload" \
    HOME="$smoke_home" \
    DSH_HOME="$smoke_home/.dsh" \
    TMPDIR="$smoke_home/tmp" \
    SHELL="$stage/usr/bin/bash" \
    DSH_SIDEBAR_SHELL="$stage/usr/bin/bash" \
    TERMUX__ROOTFS="$stage" \
    TERMUX__PREFIX="$stage/usr" \
    TERMUX_PREFIX="$stage/usr" \
    PREFIX="$stage/usr" \
    TERMUX_HOME="$smoke_home" \
    TERMUX_EXEC__SYSTEM_LINKER_EXEC__MODE=force \
    TERMUX_EXEC__EXECVE_CALL__INTERCEPT=1 \
    DSH_ANDROID_STANDALONE=1 \
    "$stage/usr/bin/node" --expose-internals \
      "$stage/usr/lib/node_modules/@deepseek-ai/dsh/lib/bin.js" \
      web --port "$port" --no-open >"$smoke_log" 2>&1 &
  local pid=$!
  local ok=0

  for _ in $(seq 1 120); do
    if ! kill -0 "$pid" 2>/dev/null; then
      break
    fi
    if curl -sS --max-time 1 -o /dev/null "http://127.0.0.1:$port/" 2>/dev/null; then
      ok=1
      break
    fi
    sleep 0.25
  done

  kill "$pid" 2>/dev/null || true
  wait "$pid" 2>/dev/null || true

  if [ "$ok" != "1" ] || grep -Eqi 'plugin tree failed to load|plugin\(s\) failed to load|Cordis startup failed because these plugin\(s\) could not be resolved' "$smoke_log"; then
    echo '[DSH] Core plugin-tree smoke test failed; refusing to package a boot-broken APK.'
    tail -n 160 "$smoke_log" || true
    exit 8
  fi

  echo '[DSH] Core plugin tree: OK (real web boot)'
  rm -rf "$smoke_home"
}

refresh_dsh_runtime() {
  [ "$DSH_REFRESH_RUNTIME" = "1" ] || return 0
  check_host_node
  check_native_toolchain
  check_git_toolchain
  local current
  current="$(snapshot_dsh_version || true)"
  echo "[DSH] Refreshing embedded runtime: DSH ${current:-unknown} -> $DSH_VERSION"
  local stage="$CACHE_DIR/runtime-latest-$DSH_VERSION"
  rm -rf "$stage"
  mkdir -p "$stage"
  tar -xJf "$SNAPSHOT" -C "$stage"
  # Avoid mixed package graphs across DSH upgrades. The global DSH package
  # owns its own dependency tree, so replacing this directory is safe while
  # the base snapshot's Android shell binaries remain untouched.
  rm -rf "$stage/usr/lib/node_modules/@deepseek-ai/dsh"

  overlay_host_node_runtime "$stage"
  install_termux_tool_runtime "$stage"
  install_terminal_shell_runtime "$stage"
  local node_headers
  node_headers="$(prepare_node_headers)"

  local primary_registry fallback_registry
  primary_registry="${DSH_NPM_REGISTRY:-$(npm config get registry 2>/dev/null || true)}"
  [ -n "$primary_registry" ] || primary_registry="https://registry.npmjs.org/"
  fallback_registry="${DSH_NPM_FALLBACK_REGISTRY:-https://registry.npmmirror.com/}"
  npm_runtime_install() {
    local registry="$1"
    echo "[DSH] npm registry: $registry"
    # DSH core plugins intentionally declare runtime services in peerDependencies.
    # Do not disable peer installation here: that can produce a package tree
    # which passes npm install but cannot resolve Cordis plugins at boot.
    # Preserve peer semantics, tolerate compatible overrides, and hide warning spam.
    npm install --global --prefix "$stage/usr" --ignore-scripts --no-audit --no-fund --prefer-offline \
      --include=peer --strict-peer-deps=false --loglevel=error \
      --registry="$registry" --fetch-retries=5 --fetch-retry-factor=2 \
      --fetch-retry-mintimeout=20000 --fetch-retry-maxtimeout=120000 --fetch-timeout=300000 \
      "@deepseek-ai/dsh@$DSH_VERSION" "pnpm@$PNPM_VERSION"
  }
  local used_registry="$primary_registry"
  if ! npm_runtime_install "$primary_registry"; then
    if [ "$fallback_registry" = "$primary_registry" ]; then
      echo '[DSH] npm runtime 刷新失败。'; exit 6
    fi
    used_registry="$fallback_registry"
    echo "[DSH] npm 主源失败，直接切换备用源: $fallback_registry"
    npm_runtime_install "$fallback_registry" || { echo '[DSH] npm 主源和备用源均失败。'; exit 6; }
  fi

  # Build only the native packages DSH actually needs.  The rest of the graph
  # stays install-script-free, which avoids accidental desktop-only postinstalls.
  build_native_modules "$stage" "$node_headers"
  validate_reusable_node_pty "$stage"
  validate_terminal_runtime "$stage"
  validate_termux_tool_runtime "$stage"
  install_sharp_wasm "$stage" "$used_registry"
  apply_android_runtime_patches "$stage"
  copy_ripgrep_runtime "$stage"
  validate_ripgrep_runtime "$stage"
  copy_git_ssh_ca_runtime "$stage"
  copy_host_npm_runtime "$stage"
  write_runtime_pnpm_wrappers "$stage"
  validate_pnpm_runtime "$stage"
  copy_native_module_deps "$stage"
  validate_dsh_core_plugin_tree "$stage"
  mkdir -p "$stage/usr/etc"
  local embedded_node
  embedded_node="$(LD_LIBRARY_PATH="$stage/usr/lib" "$stage/usr/bin/node" -p 'process.versions.node' 2>/dev/null || true)"
  cat > "$stage/usr/etc/dsh-android-compat.json" <<EOF
{
  "schema": 1,
  "app": "0.1.1",
  "dsh": "$DSH_VERSION",
  "node": "$embedded_node",
  "requireBuiltinFallback": true,
  "flockSingleProcessFallback": true,
  "hardLinkFallbacks": true,
  "sharpWasmFallback": true,
  "gitHttpsRuntime": true,
  "sshRuntime": true,
  "caBundle": true,
  "npmNpxRuntime": true,
  "pnpmBuildApproval": true,
  "pluginProfileValidation": true,
  "corePluginTreeSmokeTest": true
}
EOF

  # node-addon-require-builtin became a mandatory startup path in DSH
  # 0.1.6-alpha.2.  Older stable-channel builds may not contain/use it, so
  # only fail closed when the selected DSH version actually requires it.
  if DSH_TARGET_VERSION="$DSH_VERSION" node - <<'NODE_REQ'
const v = process.env.DSH_TARGET_VERSION || ''
const parse = (s) => {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-(alpha|beta|rc)\.(\d+))?/.exec(s)
  if (!m) return null
  const rank = m[4] === 'alpha' ? 0 : m[4] === 'beta' ? 1 : m[4] === 'rc' ? 2 : 3
  return [Number(m[1]), Number(m[2]), Number(m[3]), rank, Number(m[5] || 0)]
}
const cmp = (a,b) => { for (let i=0;i<a.length;i++) if (a[i] !== b[i]) return a[i]-b[i]; return 0 }
const cur=parse(v), threshold=parse('0.1.6-alpha.2')
process.exit(cur && threshold && cmp(cur, threshold) >= 0 ? 0 : 1)
NODE_REQ
  then
    if ! grep -Rqs 'DSH Android compat: node-addon-require-builtin JS fallback' "$stage/usr/lib/node_modules"; then
      echo '[DSH] mandatory node-addon-require-builtin compatibility patch missing.'; exit 7
    fi
  fi

  local rebuilt="$CACHE_DIR/snapshot-dsh-$DSH_VERSION-android.tar.xz"
  rm -f "$rebuilt"
  repack_snapshot_stage "$stage" "$rebuilt"
  cp "$rebuilt" "$SNAPSHOT"
  rm -rf "$stage"
  snapshot_valid || { echo '[DSH] DSH 刷新后基础运行时校验失败。'; exit 4; }
  snapshot_has_pnpm || { echo '[DSH] DSH 刷新后 pnpm 校验失败。'; exit 4; }
  current="$(snapshot_dsh_version || true)"
  [ "$current" = "$DSH_VERSION" ] || { echo "[DSH] 期望 DSH $DSH_VERSION，实际 $current"; exit 4; }
  echo "[DSH] Android-compatible DSH runtime OK: $current"
}

if ! snapshot_valid; then
  [ ! -e "$SNAPSHOT" ] || echo '[DSH] 检测到不完整/不兼容的 snapshot，重新提取。'
  rm -f "$SNAPSHOT"
  mkdir -p "$(dirname "$SNAPSHOT")" "$CACHE_DIR"
  APK_SOURCE=""
  if apk_valid "$RELEASE_APK_DOWNLOAD"; then
    APK_SOURCE="$RELEASE_APK_DOWNLOAD"
  elif apk_valid "$CACHE_APK"; then
    APK_SOURCE="$CACHE_APK"
  else
    if [ -s "$RELEASE_APK_DOWNLOAD" ]; then
      echo '[DSH] Download 中同名 APK 的 SHA-256 不匹配，忽略。'
    fi
    echo '[DSH] 正在获取官方 dsh-mobile v0.10.1 APK 中的运行时…'
    curl -L --fail --retry 3 --connect-timeout 20 -o "$CACHE_APK.part" "$RELEASE_URL"
    if [ "$(sha256sum "$CACHE_APK.part" | awk '{print $1}')" != "$RELEASE_APK_SHA256" ]; then
      echo '[DSH] 官方 APK SHA-256 校验失败，停止构建。'
      rm -f "$CACHE_APK.part"
      exit 4
    fi
    mv "$CACHE_APK.part" "$CACHE_APK"
    APK_SOURCE="$CACHE_APK"
  fi
  echo "[DSH] 提取运行时: $APK_SOURCE"
  unzip -p "$APK_SOURCE" assets/snapshot.tar.xz > "$SNAPSHOT"
fi

if ! snapshot_valid; then
  echo '[DSH] snapshot 校验失败：缺少 node / dsh / termux-exec preload，拒绝生成会启动失败的 APK。'
  rm -f "$SNAPSHOT"
  exit 4
fi

if [ "$DSH_REFRESH_RUNTIME" = "1" ]; then
  refresh_dsh_runtime
else
  ensure_pnpm_runtime
fi

if snapshot_has_git_runtime; then
  echo '[DSH] Git/SSH/CA runtime: OK'
elif [ "$DSH_REFRESH_RUNTIME" = "1" ] && [ "$DSH_GIT_COMPAT" = "1" ]; then
  echo '[DSH] Git/SSH/CA runtime 校验失败；拒绝生成 GitHub 插件支持不完整的 APK。'
  exit 8
else
  echo '[DSH] 警告：当前离线 snapshot 未包含完整 Git/SSH/CA runtime；git/github spec 可能受限。'
fi
if snapshot_has_npm_runtime; then
  echo '[DSH] npm/npx plugin runtime: OK'
elif [ "$DSH_REFRESH_RUNTIME" = "1" ]; then
  echo '[DSH] npm/npx runtime 校验失败；拒绝生成插件 prepare 脚本兼容性不完整的 APK。'
  exit 8
else
  echo '[DSH] 警告：离线 snapshot 未包含 npm/npx；部分社区插件 prepare 脚本可能失败。'
fi
echo "[DSH] Runtime snapshot + pnpm OK: $(du -h "$SNAPSHOT" | awk '{print $1}')"
RUNTIME_DSH_VERSION="$(snapshot_dsh_version || true)"
RUNTIME_SHA256="$(sha256sum "$SNAPSHOT" | awk '{print $1}')"
printf 'app=0.1.1\ndsh=%s\nsha256=%s\n' "$RUNTIME_DSH_VERSION" "$RUNTIME_SHA256" > "$ROOT/app/src/main/assets/runtime-version.txt"
echo "[DSH] Runtime ID: DSH ${RUNTIME_DSH_VERSION:-unknown} / ${RUNTIME_SHA256:0:12}"

AAPT2_BIN="$(command -v aapt2)"
echo "[DSH] aapt2: $AAPT2_BIN"
echo '[DSH] 开始构建 APK…'

# Project may live on /storage/emulated/0 (noexec). Calling the wrapper through
# bash avoids executing gradlew from the shared-storage mount. Gradle itself is
# unpacked under GRADLE_USER_HOME in Termux private storage. Keep the full build
# output in a file; on failure only print the useful compiler/error lines so a
# phone terminal is not flooded by hundreds of stack frames.
BUILD_LOG="$ROOT/build-termux.log"
set +e
bash ./gradlew --no-daemon --console=plain :app:assembleDebug \
  -Pandroid.aapt2FromMavenOverride="$AAPT2_BIN" \
  2>&1 | tee "$BUILD_LOG"
GRADLE_STATUS=${PIPESTATUS[0]}
set -e
if [ "$GRADLE_STATUS" -ne 0 ]; then
  echo
  echo "[DSH] BUILD FAILED. 关键错误："
  grep -E '(^e: |^error: |Execution failed|What went wrong|Compilation error|Unresolved reference|Cannot access|requires API|FAILURE:)' "$BUILD_LOG" | tail -n 80 || true
  echo "[DSH] 完整日志: $BUILD_LOG"
  exit "$GRADLE_STATUS"
fi

APK="$ROOT/app/build/outputs/apk/debug/app-debug.apk"
if [ -f "$APK" ]; then
  echo "[DSH] BUILD OK: $APK"
else
  echo '[DSH] Gradle finished but APK was not found.'
  exit 5
fi
