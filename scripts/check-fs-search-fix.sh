#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
P="$ROOT/scripts/android-runtime-patch.mjs"
BG="$ROOT/app/build.gradle.kts"
MA="$ROOT/app/src/main/java/com/dshmobile/shell/MainActivity.kt"
BT="$ROOT/build-termux.sh"
fail(){ echo "[FAIL] $*" >&2; exit 1; }
must(){ grep -Fq "$2" "$1" || fail "missing in $(basename "$1"): $2"; }

must "$P" "'@vscode/ripgrep'"
must "$P" 'DSH Android compat: DSH_RG_PATH override'
must "$P" 'const assignedImport ='
must "$P" 'process.env.DSH_RG_PATH'
must "$P" 'ripgrepResolverOverrideReady()'
must "$BT" 'validate_ripgrep_runtime()'
must "$BT" 'validate_ripgrep_runtime "$stage"'
must "$BG" 'versionName = "0.1.1"'
must "$BG" 'versionCode = 36'
must "$MA" 'DSH-Android/0.1.1'
must "$BT" '"app": "0.1.1"'
node --check "$P" >/dev/null

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
USR="$TMP/usr"
mkdir -p \
  "$USR/lib/node_modules/@deepseek-ai/dsh-tool-fs-search/lib" \
  "$USR/lib/node_modules/@vscode/ripgrep/lib"
cat > "$USR/lib/node_modules/@deepseek-ai/dsh-tool-fs-search/package.json" <<'JSON'
{"name":"@deepseek-ai/dsh-tool-fs-search","type":"module"}
JSON
# Exact shape that broke v0.13.3: published 0.1.5-rc.2 stores rgPath first.
cat > "$USR/lib/node_modules/@deepseek-ai/dsh-tool-fs-search/lib/index.js" <<'JS'
let rgPathPromise;
export function resolveRgPath() {
  rgPathPromise ??= Promise.resolve().then(async () => {
    let rgPath = (await import("@vscode/ripgrep")).rgPath;
    return rgPath;
  });
  return rgPathPromise;
}
JS
cat > "$USR/lib/node_modules/@vscode/ripgrep/package.json" <<'JSON'
{"name":"@vscode/ripgrep","type":"module"}
JSON
cat > "$USR/lib/node_modules/@vscode/ripgrep/lib/index.js" <<'JS'
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const arch = process.env.npm_config_arch || process.arch;
const binaryName = process.platform === 'win32' ? 'rg.exe' : 'rg';
const platformPkg = `@vscode/ripgrep-${process.platform}-${arch}`;
let resolved;
try {
  resolved = require.resolve(`${platformPkg}/bin/${binaryName}`);
} catch {
  throw new Error(`Could not find ${platformPkg}.`);
}
export const rgPath = resolved;
JS
DSH_TARGET_VERSION=0.1.0 node "$P" "$USR" >/dev/null
must "$USR/lib/node_modules/@deepseek-ai/dsh-tool-fs-search/lib/index.js" 'DSH Android compat: external rg path'
must "$USR/lib/node_modules/@vscode/ripgrep/lib/index.js" 'DSH Android compat: DSH_RG_PATH override'
node --check "$USR/lib/node_modules/@deepseek-ai/dsh-tool-fs-search/lib/index.js" >/dev/null
node --check "$USR/lib/node_modules/@vscode/ripgrep/lib/index.js" >/dev/null
DSH_RG_PATH="$TMP/rg" RESOLVER="$USR/lib/node_modules/@vscode/ripgrep/lib/index.js" \
node --input-type=module -e '
  import { pathToFileURL } from "node:url";
  const mod = await import(pathToFileURL(process.env.RESOLVER).href);
  if (mod.rgPath !== process.env.DSH_RG_PATH) process.exit(1);
'

# Also preserve direct-return bundle compatibility.
TMP2="$TMP/direct"
mkdir -p "$TMP2/usr/lib/node_modules/@deepseek-ai/dsh-tool-fs-search/lib"
cat > "$TMP2/usr/lib/node_modules/@deepseek-ai/dsh-tool-fs-search/package.json" <<'JSON'
{"name":"@deepseek-ai/dsh-tool-fs-search","type":"module"}
JSON
cat > "$TMP2/usr/lib/node_modules/@deepseek-ai/dsh-tool-fs-search/lib/search-core.js" <<'JS'
export async function resolveRgPath() {
  return (await import('@vscode/ripgrep')).rgPath;
}
JS
# eachPackage requires lib/index.js as the entry target even though patchFsSearchPackage scans all lib files.
cat > "$TMP2/usr/lib/node_modules/@deepseek-ai/dsh-tool-fs-search/lib/index.js" <<'JS'
export * from './search-core.js';
JS
DSH_TARGET_VERSION=0.1.0 node "$P" "$TMP2/usr" >/dev/null
must "$TMP2/usr/lib/node_modules/@deepseek-ai/dsh-tool-fs-search/lib/search-core.js" 'DSH Android compat: external rg path'
node --check "$TMP2/usr/lib/node_modules/@deepseek-ai/dsh-tool-fs-search/lib/search-core.js" >/dev/null

echo '[OK] fs-search/ripgrep published-layout compatibility regression checks passed'
