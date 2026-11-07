#!/system/bin/sh
# System linker bridge for dynamically linked ARM64 app-private ELF binaries.
# Called via /system/bin/sh; preserves exact command argument boundaries.
set -e
[ "$#" -ge 1 ] || { echo DSH_ANDROID_EXEC_NO_COMMAND >&2; exit 125; }
program="$1"; shift
prefix="${TERMUX__PREFIX:-${PREFIX:-}}"
[ -n "$prefix" ] || { echo DSH_ANDROID_EXEC_PREFIX_MISSING >&2; exit 125; }
case "$program" in
  /*) target="$program" ;;
  */*) target="$PWD/$program" ;;
  *) target="$(command -v "$program" 2>/dev/null || true)" ;;
esac
[ -n "$target" ] && [ -f "$target" ] || { echo "DSH_ANDROID_EXEC_NOT_FOUND: $program" >&2; exit 127; }
case "$target" in
  /system/*|/apex/*) exec "$target" "$@" ;;
esac
head_cmd="${DSH_ANDROID_HEAD:-/system/bin/head}"
linker="${DSH_ANDROID_LINKER64:-/system/bin/linker64}"
magic="$("$head_cmd" -c 4 "$target" 2>/dev/null || true)"
case "$magic" in
  "$(printf '\177ELF')"*)
    # Note: fully statically linked ELF has no PT_INTERP and cannot use linker64.
    exec "$linker" "$target" "$@"
    ;;
  '#!'*)
    first_line="$("$head_cmd" -n 1 "$target" 2>/dev/null || true)"
    interpreter="${first_line#\#!}"
    interpreter="${interpreter# }"
    interpreter="${interpreter%% *}"
    name="${interpreter##*/}"
    case "$name" in
      sh) exec /system/bin/sh "$target" "$@" ;;
      bash|dash|zsh|python|python3|node|perl|ruby|env)
        [ "$name" != python ] || name=python3
        if [ "$name" = env ]; then
          env_command="${first_line#*env }"
          env_command="${env_command%% *}"
          case "$env_command" in
            bash|dash|zsh|python3|node|perl|ruby) name="$env_command" ;;
            *) echo "DSH_ANDROID_EXEC_UNSUPPORTED_ENV_SHEBANG: $target" >&2; exit 126 ;;
          esac
        fi
        [ -f "$prefix/bin/$name" ] || { echo "DSH_ANDROID_EXEC_INTERPRETER_MISSING: $name" >&2; exit 127; }
        exec "$linker" "$prefix/bin/$name" "$target" "$@"
        ;;
      *) echo "DSH_ANDROID_EXEC_UNSUPPORTED_SHEBANG: $target" >&2; exit 126 ;;
    esac
    ;;
  *)
    echo "DSH_ANDROID_EXEC_NOT_ELF_OR_SCRIPT: $target" >&2
    exit 126
    ;;
esac
