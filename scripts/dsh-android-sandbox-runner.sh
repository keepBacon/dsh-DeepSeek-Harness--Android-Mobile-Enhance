#!/system/bin/sh
set -u

fail() {
  printf '%s\n' "dsh-android-sandbox: runner failure: $*" >&2
  exit 125
}

[ "$#" -ge 4 ] || fail "expected MODE WORKSPACE -- COMMAND..."
mode="$1"
workspace="$2"
shift 2
[ "$1" = "--" ] || fail "missing -- separator"
shift
[ "$#" -ge 1 ] || fail "missing command"

case "$mode" in
  read-only|workspace-write) ;;
  *) fail "unsupported confined mode: $mode" ;;
esac

case "$workspace" in
  /*) ;;
  *) fail "workspace root must be absolute" ;;
esac
[ -d "$workspace" ] || fail "workspace root does not exist: $workspace"

# Android has no reliable app-accessible bwrap/Landlock backend. This runner
# keeps confined calls on an explicit, auditable execution path and preserves
# exact argv/PID semantics via exec. The outer Android app UID is the process
# boundary; DSH fs-sandbox remains the authoritative workspace-write fence for
# model file mutations. Process confinement is therefore reported as partial
# by the patched sandbox-local provider.
export DSH_ANDROID_SANDBOX_MODE="$mode"
export DSH_ANDROID_SANDBOX_WORKSPACE_ROOT="$workspace"
export DSH_ANDROID_SANDBOX_ENFORCEMENT="partial"

# Keep the app-private temp root explicit so tools do not silently fall back to
# inaccessible /tmp on Android.
if [ -n "${TMPDIR:-}" ]; then
  mkdir -p "$TMPDIR" 2>/dev/null || true
fi

exec "$@"
