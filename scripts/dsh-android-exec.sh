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
    # Android's `head` can return CRLF source files. Parse the interpreter
    # token independently of optional shebang flags; never use eval/word
    # splitting on the user's script path or command arguments.
    first_line="${first_line%"$(printf '\\r')"}"
    shebang="${first_line#\#!}"
    shebang="${shebang# }"
    interpreter="${shebang%% *}"
    options=""
    if [ "$interpreter" != "$shebang" ]; then options="${shebang#"$interpreter"}"; options="${options# }"; fi
    name="${interpreter##*/}"
    case "$name" in
      sh) exec /system/bin/sh "$target" "$@" ;;
      bash|dash|zsh|python|python3|node|perl|ruby|env)
        [ "$name" != python ] || name=python3
        if [ "$name" = env ]; then
          # The common `env -S python3` and `env python3` forms are both
          # supported. Reject other inline flags instead of silently
          # dropping them or executing an unexpected interpreter.
          case "$options" in '-S '*) options="${options#-S }" ;; esac
          env_command="${options%% *}"
          case "$env_command" in
            bash|dash|zsh|python|python3|node|perl|ruby) name="$env_command" ;;
            *) echo "DSH_ANDROID_EXEC_UNSUPPORTED_ENV_SHEBANG: $target" >&2; exit 126 ;;
          esac
          [ "$name" != python ] || name=python3
          if [ "$options" != "$env_command" ]; then
            echo "DSH_ANDROID_EXEC_UNSUPPORTED_ENV_FLAGS: $target" >&2
            exit 126
          fi
          options=""
        fi
        [ -f "$prefix/bin/$name" ] || { echo "DSH_ANDROID_EXEC_INTERPRETER_MISSING: $name" >&2; exit 127; }
        # Honor one common shebang interpreter flag without lossy
        # splitting. Reject arbitrary multi-token arguments (env -S
        # quoting semantics require the real env parser).
        case "$options" in
          '') exec "$linker" "$prefix/bin/$name" "$target" "$@" ;;
          -*)
            case "$options" in *' '*|*'	'*) echo "DSH_ANDROID_EXEC_UNSUPPORTED_SHEBANG_FLAGS: $target" >&2; exit 126 ;; esac
            exec "$linker" "$prefix/bin/$name" "$options" "$target" "$@"
            ;;
          *) echo "DSH_ANDROID_EXEC_UNSUPPORTED_SHEBANG_FLAGS: $target" >&2; exit 126 ;;
        esac
        ;;
      *) echo "DSH_ANDROID_EXEC_UNSUPPORTED_SHEBANG: $target" >&2; exit 126 ;;
    esac
    ;;
  *)
    echo "DSH_ANDROID_EXEC_NOT_ELF_OR_SCRIPT: $target" >&2
    exit 126
    ;;
esac
