# Sourced by non-interactive embedded Bash through BASH_ENV.
# Android forbids execve of scripts and ELF files under the app's writable
# filesDir (noexec). Never put those wrappers on Bash's command search PATH:
# resolve system commands normally and dispatch embedded Termux tools through
# the trusted system shell + linker bridge, with argv boundaries preserved.
if [ "${DSH_ANDROID_STANDALONE:-}" = "1" ]; then
  _dsh_mobile_prefix="${TERMUX__PREFIX:-${PREFIX:-}}"
  if [ -n "$_dsh_mobile_prefix" ]; then
    # Android system tools are executable; the embedded wrappers are not.
    PATH=/system/bin:/system/xbin
    export PATH

    # Bash's command_not_found_handle runs only after command lookup fails.
    # Explicit functions also make "command -v node/npm/npx/pnpm" work for
    # model-generated build scripts, without putting noexec files on PATH.
    _dsh_mobile_node() {
      if [ ! -f "$_dsh_mobile_prefix/bin/node" ]; then
        printf 'dsh: embedded Node.js executable missing: %s\n' "$_dsh_mobile_prefix/bin/node" >&2
        return 127
      fi
      # npm/pnpm (and user scripts) commonly launch Git through Node's
      # child_process API, bypassing Bash's noexec command dispatch. Enable
      # the existing Git-only adapter for model-initiated Node processes too.
      # No shell interpolation or modification of the script argv is needed.
      local _dsh_git_preload="$_dsh_mobile_prefix/libexec/dsh-mobile/dsh-android-plugin-git-spawn.cjs"
      if [ -f "$_dsh_git_preload" ]; then
        case " ${NODE_OPTIONS:-} " in
          *" --require=$_dsh_git_preload "*)
            # Shared Host environment already enabled the adapter.
            /system/bin/sh "$_dsh_mobile_prefix/libexec/dsh-mobile/android-exec.sh" "$_dsh_mobile_prefix/bin/node" "$@"
            ;;
          *)
            NODE_OPTIONS="${NODE_OPTIONS:+$NODE_OPTIONS }--require=$_dsh_git_preload" \
              /system/bin/sh "$_dsh_mobile_prefix/libexec/dsh-mobile/android-exec.sh" "$_dsh_mobile_prefix/bin/node" "$@"
            ;;
        esac
      else
        /system/bin/sh "$_dsh_mobile_prefix/libexec/dsh-mobile/android-exec.sh" "$_dsh_mobile_prefix/bin/node" "$@"
      fi
    }
    _dsh_mobile_js_cli() {
      local _dsh_entry="$1"
      shift
      if [ ! -f "$_dsh_entry" ]; then
        printf 'dsh: embedded JavaScript CLI missing: %s\n' "$_dsh_entry" >&2
        return 127
      fi
      _dsh_mobile_node "$_dsh_entry" "$@"
    }
    node() { _dsh_mobile_node "$@"; }
    npm() { _dsh_mobile_js_cli "$_dsh_mobile_prefix/lib/node_modules/npm/bin/npm-cli.js" "$@"; }
    npx() { _dsh_mobile_js_cli "$_dsh_mobile_prefix/lib/node_modules/npm/bin/npx-cli.js" "$@"; }
    pnpm() {
      local _dsh_pnpm
      for _dsh_pnpm in \
        "$_dsh_mobile_prefix/lib/node_modules/pnpm/bin/pnpm.cjs" \
        "$_dsh_mobile_prefix/lib/node_modules/pnpm/bin/pnpm.mjs" \
        "$_dsh_mobile_prefix/lib/node_modules/pnpm/bin/pnpm.js"; do
        if [ -f "$_dsh_pnpm" ]; then
          _dsh_mobile_node "$_dsh_pnpm" "$@"
          return $?
        fi
      done
      printf 'dsh: embedded pnpm CLI missing\n' >&2
      return 127
    }
    pnpx() { pnpm dlx "$@"; }

    command_not_found_handle() {
      local _dsh_cmd="${1:-}"
      [ "$#" -gt 0 ] && shift
      case "$_dsh_cmd" in
        ''|*[!A-Za-z0-9._+-]*)
          printf 'dsh: command not found: %s\n' "$_dsh_cmd" >&2
          return 127
          ;;
      esac
      if [ "$_dsh_cmd" = termux-run ]; then
        /system/bin/sh "$_dsh_mobile_prefix/libexec/dsh/termux-run" "$@"
      elif [ "$_dsh_cmd" = node ]; then
        # Model Bash cannot execve app-private ELF directly on Android.
        # Dispatch Node explicitly even if the generic CLI wrapper is absent.
        if [ ! -f "$_dsh_mobile_prefix/bin/node" ]; then
          printf 'dsh: embedded Node.js executable missing: %s\n' "$_dsh_mobile_prefix/bin/node" >&2
          return 127
        fi
        /system/bin/sh "$_dsh_mobile_prefix/libexec/dsh-mobile/android-exec.sh" "$_dsh_mobile_prefix/bin/node" "$@"
      elif [ -L "$_dsh_mobile_prefix/libexec/dsh/wrappers/$_dsh_cmd" ]; then
        DSH_WRAPPER_COMMAND="$_dsh_cmd" DSH_TERMUX_INNER=1 \
          /system/bin/sh "$_dsh_mobile_prefix/libexec/dsh/termux-wrapper" "$@"
      else
        printf 'dsh: command not found: %s\n' "$_dsh_cmd" >&2
        return 127
      fi
    }
  fi
fi
