#!/data/data/com.termux/files/usr/bin/bash
set -Eeuo pipefail

: "${ROOT:?ROOT is required}"
: "${CACHE_DIR:?CACHE_DIR is required}"
: "${NPM_BUILD_CACHE:?NPM_BUILD_CACHE is required}"
: "${PNPM_TGZ:?PNPM_TGZ is required}"
: "${PNPM_URL:?PNPM_URL is required}"
: "${DSH_VERSION:?DSH_VERSION is required}"
: "${PNPM_VERSION:?PNPM_VERSION is required}"
: "${DSH_RELEASE_FAMILY_LOCK:?DSH_RELEASE_FAMILY_LOCK is required}"
: "${DSH_RUNTIME_FAMILY_TOOL:?DSH_RUNTIME_FAMILY_TOOL is required}"

check_free_kb() {
  local path="$1" required_kb="$2" label="$3"
  local available
  available="$(df -Pk "$path" 2>/dev/null | awk 'NR==2 {print $4}')"
  case "$available" in
    ''|*[!0-9]*)
      echo "[DSH] Cannot determine free space for $label: $path" >&2
      return 7
      ;;
  esac
  if [ "$available" -lt "$required_kb" ]; then
    echo "[DSH] Insufficient free space for $label: $((available / 1024)) MiB available, $((required_kb / 1024)) MiB required." >&2
    return 7
  fi
  echo "[DSH] Free space $label: $((available / 1024)) MiB"
}

dsh_frontload_expensive_runtime_main() {
  [ "${DSH_REFRESH_RUNTIME:-1}" = "1" ] || return 0

  local host_prefix="${PREFIX:-/data/data/com.termux/files/usr}"
  local min_home_kb="${DSH_MIN_HOME_FREE_KB:-4194304}"
  local min_project_kb="${DSH_MIN_PROJECT_FREE_KB:-2097152}"
  local npm_cli="$host_prefix/lib/node_modules/npm/bin/npm-cli.js"
  local manifest="$CACHE_DIR/frontload-runtime-package.json"
  local probe="$CACHE_DIR/frontload-runtime-graph"
  local selected="$CACHE_DIR/frontload-runtime-selected"
  local log="$CACHE_DIR/frontload-runtime-preflight.log"
  local registry_file="$CACHE_DIR/frontload-selected-registry.txt"
  local primary fallback registry sharp_version

  mkdir -p "$CACHE_DIR" "$NPM_BUILD_CACHE"
  : > "$log"

  check_free_kb "$HOME" "$min_home_kb" "Termux HOME/runtime cache"
  check_free_kb "$ROOT" "$min_project_kb" "project/snapshot output"

  [ -d "$host_prefix/include/node" ] || {
    echo "[DSH] Termux Node headers missing before expensive overlay: $host_prefix/include/node" >&2
    return 7
  }
  [ -f "$host_prefix/include/node/common.gypi" ] || {
    echo "[DSH] Node common.gypi missing before expensive overlay." >&2
    return 7
  }

  local archive_probe="$CACHE_DIR/archive-preflight"
  rm -rf "$archive_probe"
  mkdir -p "$archive_probe/src"
  printf 'dsh-runtime-archive-probe\n' > "$archive_probe/src/probe.txt"
  (cd "$archive_probe/src" && XZ_OPT="-0" tar -cJf "$archive_probe/probe.tar.xz" probe.txt) >>"$log" 2>&1
  tar -xOJf "$archive_probe/probe.tar.xz" probe.txt 2>>"$log"     | awk '$0=="dsh-runtime-archive-probe" {ok=1} END {exit !ok}' || {
      echo "[DSH] tar/xz archive round-trip preflight failed." >&2
      tail -n 100 "$log" >&2 || true
      return 7
    }
  rm -rf "$archive_probe"

  [ -f "$DSH_RELEASE_FAMILY_LOCK" ] || {
    echo "[DSH] Missing release-family lock: $DSH_RELEASE_FAMILY_LOCK" >&2
    return 7
  }
  [ -f "$DSH_RUNTIME_FAMILY_TOOL" ] || {
    echo "[DSH] Missing runtime-family tool: $DSH_RUNTIME_FAMILY_TOOL" >&2
    return 7
  }
  [ -f "$npm_cli" ] || {
    echo "[DSH] Host npm CLI missing before expensive overlay: $npm_cli" >&2
    return 7
  }

  node "$DSH_RUNTIME_FAMILY_TOOL" manifest     "$DSH_RELEASE_FAMILY_LOCK" "$DSH_VERSION" "$PNPM_VERSION" > "$manifest"

  primary="${DSH_NPM_REGISTRY:-$(npm config get registry 2>/dev/null || true)}"
  [ -n "$primary" ] || primary="https://registry.npmjs.org/"
  fallback="${DSH_NPM_FALLBACK_REGISTRY:-https://registry.npmmirror.com/}"

  preload_registry() {
    local reg="$1"
    rm -rf "$probe"
    mkdir -p "$probe"
    cp "$manifest" "$probe/package.json"

    (cd "$probe" && node "$npm_cli" install --package-lock-only       --ignore-scripts --no-audit --no-fund --prefer-offline       --include=peer --strict-peer-deps=false --loglevel=error       --cache "$NPM_BUILD_CACHE" --registry="$reg"       --fetch-retries=3 --fetch-retry-factor=2       --fetch-retry-mintimeout=10000 --fetch-retry-maxtimeout=60000       --fetch-timeout=180000) >>"$log" 2>&1 || return 1

    node "$DSH_RUNTIME_FAMILY_TOOL" verify-lock       "$DSH_RELEASE_FAMILY_LOCK" "$probe/package-lock.json" "$DSH_VERSION" >>"$log" 2>&1 || return 1

    (cd "$probe" && node "$npm_cli" ci       --ignore-scripts --no-audit --no-fund --prefer-offline       --include=peer --strict-peer-deps=false --loglevel=error       --cache "$NPM_BUILD_CACHE" --registry="$reg"       --fetch-retries=3 --fetch-retry-mintimeout=10000       --fetch-retry-maxtimeout=60000 --fetch-timeout=180000) >>"$log" 2>&1 || return 1

    node "$DSH_RUNTIME_FAMILY_TOOL" verify-installed       "$DSH_RELEASE_FAMILY_LOCK" "$probe/node_modules" "$DSH_VERSION" >>"$log" 2>&1 || return 1

    rm -rf "$probe/node_modules"
    (cd "$probe" && node "$npm_cli" ci       --offline --ignore-scripts --no-audit --no-fund       --include=peer --strict-peer-deps=false --loglevel=error       --cache "$NPM_BUILD_CACHE") >>"$log" 2>&1 || return 1

    node "$DSH_RUNTIME_FAMILY_TOOL" verify-installed       "$DSH_RELEASE_FAMILY_LOCK" "$probe/node_modules" "$DSH_VERSION" >>"$log" 2>&1
  }

  echo "[DSH] Preloading complete locked DSH graph before expensive Runtime overlay…"
  if preload_registry "$primary"; then
    registry="$primary"
  elif [ "$fallback" != "$primary" ] && preload_registry "$fallback"; then
    registry="$fallback"
  else
    echo "[DSH] Locked DSH graph cannot be downloaded and replayed offline." >&2
    tail -n 200 "$log" >&2 || true
    return 7
  fi

  sharp_version="$(node -e '
    const fs=require("fs"), path=require("path");
    const root=process.argv[1]; let found="";
    const walk=d=>{if(found)return;for(const n of fs.readdirSync(d)){const q=path.join(d,n);let s;try{s=fs.statSync(q)}catch{continue}
      if(s.isDirectory()){if(n==="sharp"&&fs.existsSync(path.join(q,"package.json"))){try{found=JSON.parse(fs.readFileSync(path.join(q,"package.json"),"utf8")).version}catch{};if(found)return}walk(q)}}};
    walk(root); if(found)process.stdout.write(found)
  ' "$probe/node_modules" 2>/dev/null || true)"

  if [ -n "$sharp_version" ]; then
    echo "[DSH] Preloading sharp WASM fallback: @img/sharp-wasm32@$sharp_version"
    node "$npm_cli" cache add "@img/sharp-wasm32@$sharp_version"       --cache "$NPM_BUILD_CACHE" --registry="$registry" >>"$log" 2>&1 || {
        echo "[DSH] sharp WASM fallback prefetch failed." >&2
        tail -n 120 "$log" >&2 || true
        return 7
      }
  fi

  mkdir -p "$(dirname "$PNPM_TGZ")"
  if [ ! -s "$PNPM_TGZ" ]; then
    curl -L --fail --retry 3 --connect-timeout 20       -o "$PNPM_TGZ.part" "$PNPM_URL" >>"$log" 2>&1 || {
        echo "[DSH] pnpm archive prefetch failed." >&2
        tail -n 100 "$log" >&2 || true
        return 7
      }
    mv "$PNPM_TGZ.part" "$PNPM_TGZ"
  fi
  tar -tzf "$PNPM_TGZ" 2>/dev/null | awk '
    /^package\/bin\/pnpm\.(cjs|mjs|js)$/ {ok=1}
    END {exit !ok}
  ' || {
    echo "[DSH] Cached pnpm archive is invalid: $PNPM_TGZ" >&2
    return 7
  }

  rm -rf "$selected"
  mkdir -p "$selected"
  cp "$probe/package.json" "$selected/package.json"
  cp "$probe/package-lock.json" "$selected/package-lock.json"
  printf '%s\n' "$registry" > "$registry_file"
  rm -rf "$probe"

  echo "[DSH] Expensive-runtime input preflight: OK"
  echo "[DSH]   DSH graph: offline-replayable"
  echo "[DSH]   sharp WASM: cached"
  echo "[DSH]   pnpm: cached + archive-validated"
  echo "[DSH]   Node headers/tar/xz/disk: OK"
}

dsh_frontload_expensive_runtime_main "$@"
