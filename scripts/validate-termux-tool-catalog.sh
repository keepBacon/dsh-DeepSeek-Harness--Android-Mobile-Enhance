#!/usr/bin/env bash
set -Eeuo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
. "$ROOT/scripts/dsh-termux-tool-catalog.sh"
dsh_tool_catalog_self_test

if [ "${1:-}" = "--online" ]; then
  command -v curl >/dev/null 2>&1
  command -v xz >/dev/null 2>&1
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT

  fetch_index() {
    local repo_name="$1" suite="$2" component="$3" out="$4" base url
    for base in "https://packages.termux.dev/apt" "https://packages-cf.termux.dev/apt"; do
      url="$base/$repo_name/dists/$suite/$component/binary-aarch64/Packages"
      if curl -fsSL --retry 2 --connect-timeout 15 "$url" -o "$out"; then
        [ -s "$out" ] && return 0
      fi
    done
    echo "[DSH] Failed to fetch official Termux aarch64 index: $repo_name/$suite/$component" >&2
    return 7
  }

  check_index() {
    local index="$1"; shift
    local pkg fail=0
    for pkg in "$@"; do
      grep -Fxq "Package: $pkg" "$index" || {
        echo "[DSH] Package missing from official Termux aarch64 index: $pkg" >&2
        fail=1
      }
    done
    [ "$fail" -eq 0 ]
  }

  fetch_index termux-main stable main "$tmp/main"
  fetch_index termux-root root stable "$tmp/root"
  read -r -a main_pkgs <<< "$DSH_TERMUX_MAIN_TOOL_PACKAGES_DEFAULT"
  read -r -a root_pkgs <<< "$DSH_TERMUX_ROOT_TOOL_PACKAGES_DEFAULT"
  check_index "$tmp/main" "${main_pkgs[@]}"
  check_index "$tmp/root" "${root_pkgs[@]}"
  echo "[DSH] Official Termux aarch64 package indexes: OK (${#main_pkgs[@]} main + ${#root_pkgs[@]} root)"
fi

echo "[DSH] Tool catalog validation: OK"
