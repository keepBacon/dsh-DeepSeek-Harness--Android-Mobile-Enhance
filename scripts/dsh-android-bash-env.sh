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
