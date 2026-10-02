#!/data/data/com.termux/files/usr/bin/bash
# Canonical Phase-1 Linux/TUI tool catalog for the embedded DSH Termux runtime.
# Package roots, commands and smoke syntax live here so install/staging/verification cannot drift.

DSH_TERMUX_MAIN_TOOL_PACKAGES_DEFAULT="apt dpkg termux-tools termux-keyring proot python python-pip coreutils findutils grep sed gawk tar gzip bzip2 xz-utils zstd lz4 cpio unzip zip 7zip curl wget aria2 jq yq less which procps diffutils patch parallel file binutils openssl openssl-tool aapt2 libc++ llvm clang lld make cmake ninja pkg-config gdb gdbserver strace ltrace rizin radare2 git git-lfs openssh shellcheck shfmt ctags cscope htop lsof tree rsync tmux fzf bat eza ncdu duf fd sd micro neovim ranger yazi glow gum dialog lazygit tig httpie dnsutils iproute2 net-tools nmap socat netcat-openbsd whois traceroute sqlite postgresql mariadb redis imagemagick ffmpeg poppler pandoc exiftool android-tools apksigner apktool jadx"
DSH_TERMUX_ROOT_TOOL_PACKAGES_DEFAULT="frida frida-python btop tcpdump"
# Hidden interpreter/runtime dependencies required by user-facing tools.
# Keep them explicit instead of relying only on transitive apt metadata:
# apksigner/apktool/jadx require Java; exiftool requires Perl.
DSH_TERMUX_RUNTIME_PACKAGES_DEFAULT="openjdk-21 perl"
DSH_TERMUX_RUNTIME_ENTRYPOINTS=("java" "jar" "jarsigner" "keytool" "javac" "perl")
DSH_TERMUX_JAVA_TOOL_COMMANDS=("apksigner" "apktool" "jadx")
DSH_NPM_DEV_TOOL_PACKAGES_DEFAULT="prettier@3.9.9 eslint@10.10.0"
DSH_PYTHON_DEV_TOOL_PACKAGES_DEFAULT="cmakelang==0.6.13"

DSH_TERMUX_REQUIRED_TOOL_SPECS=(
  "openssl|openssl-tool|word"
  "file|file|long"
  "curl|curl|long"
  "wget|wget|long"
  "aria2c|aria2|long"
  "jq|jq|long"
  "yq|yq|long"
  "proot|proot|long"
  "python3|python|long"
  "pip3|python-pip|long"
  "aapt2|aapt2|word"
  "adb|android-tools|word"
  "apksigner|apksigner|long"
  "apktool|apktool|long"
  "jadx|jadx|long"
  "gdb|gdb|long"
  "gdbserver|gdbserver|long"
  "strace|strace|short-V"
  "ltrace|ltrace|long"
  "rizin|rizin|short-v"
  "r2|radare2|short-v"
  "frida|frida-python|long"
  "frida-ps|frida-python|help"
  "frida-trace|frida-python|help"
  "frida-server|frida|long"
  "7z|7zip|sevenzip"
  "sqlite3|sqlite|long"
  "cmake|cmake|long"
  "ninja|ninja|long"
  "clang|clang|long"
  "clang-format|clang|long"
  "llvm-config|llvm|long"
  "ld.lld|lld|long"
  "ss|iproute2|short-V"
  "ip|iproute2|ip-version"
  "dig|dnsutils|short-v"
  "ifconfig|net-tools|long"
  "nmap|nmap|long"
  "socat|socat|short-V"
  "nc|netcat-openbsd|help-any"
  "whois|whois|help-any"
  "traceroute|traceroute|long"
  "tcpdump|tcpdump|long"
  "magick|imagemagick|dash-version"
  "ffmpeg|ffmpeg|dash-version"
  "ffprobe|ffmpeg|dash-version"
  "pdfinfo|poppler|short-v"
  "pdftotext|poppler|short-v"
  "pdfimages|poppler|short-v"
  "pdftoppm|poppler|short-v"
  "pandoc|pandoc|long"
  "exiftool|exiftool|exif"
  "psql|postgresql|long"
  "mariadb|mariadb|long"
  "redis-cli|redis|long"
  "git|git|long"
  "git-lfs|git-lfs|word"
  "shellcheck|shellcheck|long"
  "shfmt|shfmt|long"
  "ctags|ctags|long"
  "cscope|cscope|short-V"
  "lazygit|lazygit|long"
  "tig|tig|long"
  "htop|htop|long"
  "btop|btop|android-root-conditional"
  "lsof|lsof|short-v"
  "tree|tree|long"
  "rsync|rsync|long"
  "tmux|tmux|short-V"
  "fzf|fzf|long"
  "bat|bat|long"
  "eza|eza|long"
  "ncdu|ncdu|long"
  "duf|duf|long"
  "fd|fd|long"
  "sd|sd|long"
  "diff|diffutils|long"
  "patch|patch|long"
  "parallel|parallel|long"
  "watch|procps|long"
  "micro|micro|long"
  "nvim|neovim|long"
  "ranger|ranger|long"
  "yazi|yazi|long"
  "glow|glow|long"
  "gum|gum|long"
  "dialog|dialog|long"
  "tar|tar|long"
  "gzip|gzip|long"
  "bzip2|bzip2|help-any"
  "xz|xz-utils|long"
  "zstd|zstd|long"
  "lz4|lz4|long"
  "cpio|cpio|long"
  "zip|zip|short-v"
  "unzip|unzip|short-v"
  "http|httpie|long"
)

DSH_TERMUX_BINUTILS_TOOLS=("ar" "addr2line" "c++filt" "nm" "objcopy" "objdump" "ranlib" "readelf" "size" "strings" "strip")

dsh_tool_catalog_self_test() {
  local spec cmd owner mode pkg
  declare -A seen_cmd=()
  for spec in "${DSH_TERMUX_REQUIRED_TOOL_SPECS[@]}"; do
    IFS='|' read -r cmd owner mode <<< "$spec"
    [ -n "$cmd" ] && [ -n "$owner" ] && [ -n "$mode" ] || { echo "[DSH] Invalid tool catalog row: $spec" >&2; return 2; }
    [ -z "${seen_cmd[$cmd]+x}" ] || { echo "[DSH] Duplicate tool catalog command: $cmd" >&2; return 2; }
    seen_cmd["$cmd"]=1
  done
  for pkg in $DSH_TERMUX_ROOT_TOOL_PACKAGES_DEFAULT; do
    case " $DSH_TERMUX_MAIN_TOOL_PACKAGES_DEFAULT " in *" $pkg "*) echo "[DSH] Tool package appears in both main/root catalogs: $pkg" >&2; return 2 ;; esac
  done
  [ "${#seen_cmd[@]}" -ge 90 ] || { echo "[DSH] Extended tool catalog unexpectedly small: ${#seen_cmd[@]}" >&2; return 2; }
  for pkg in $DSH_TERMUX_RUNTIME_PACKAGES_DEFAULT; do
    [ -n "$pkg" ] || { echo "[DSH] Empty runtime interpreter package in catalog." >&2; return 2; }
  done
  for cmd in "${DSH_TERMUX_JAVA_TOOL_COMMANDS[@]}"; do
    [ -n "${seen_cmd[$cmd]+x}" ] || { echo "[DSH] Java-backed tool missing from required catalog: $cmd" >&2; return 2; }
  done
  echo "[DSH] Extended Linux/TUI tool catalog: OK (${#seen_cmd[@]} commands + runtime interpreters)"
}

dsh_tool_spec_for() {
  local wanted="$1" spec cmd owner mode
  for spec in "${DSH_TERMUX_REQUIRED_TOOL_SPECS[@]}"; do
    IFS='|' read -r cmd owner mode <<< "$spec"
    if [ "$cmd" = "$wanted" ]; then printf "%s|%s\n" "$owner" "$mode"; return 0; fi
  done
  return 1
}
