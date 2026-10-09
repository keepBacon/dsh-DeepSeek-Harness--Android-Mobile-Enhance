#!/data/data/com.termux/files/usr/bin/bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PATCH="$ROOT/scripts/android-runtime-patch.mjs"
ENGINE="$ROOT/app/src/main/java/com/dshmobile/shell/EngineManager.kt"

must() {
  local file="$1" needle="$2"
  grep -Fq -- "$needle" "$file" || { echo "[FAIL] missing in $file: $needle" >&2; exit 1; }
}

must "$PATCH" "@deepseek-ai/cordis-plugin-loader"
must "$PATCH" "DSH Android compat: identical duplicate loader entry collapse"
must "$PATCH" "androidEntryCanonical"
must "$PATCH" "androidUnique"
must "$ENGINE" "检测到重复 loader entry id"

TMP="$(mktemp -d)"
trap 'status=$?; if [ "$status" -ne 0 ]; then echo "[FAIL] duplicate loader regression (exit $status)" >&2; for log in "$TMP"/*.stderr; do [ -f "$log" ] && { echo "[DSH] $log" >&2; cat "$log" >&2; }; done; fi; rm -rf "$TMP"' EXIT
PKG="$TMP/usr/lib/node_modules/@deepseek-ai/cordis-plugin-loader"
mkdir -p "$PKG/lib" "$TMP/home/.dsh/profiles/web"

cat > "$PKG/package.json" <<'JSON'
{"name":"@deepseek-ai/cordis-plugin-loader","version":"1.0.3"}
JSON

cat > "$PKG/lib/index.js" <<'JS'
class EntryGroup {
  constructor() {
    this.data = [];
    this.tree = { ensureId(options) { return options.id; } };
    this.ctx = { logger: { warn() {} }, fiber: { uid: 1 } };
  }
  async create(options) { return options.id; }
  async remove() {}
  async update(config) {
    const oldConfig = this.data;
    const seen = new Set();
    for (const options of config) {
      const id = this.tree.ensureId(options);
      if (seen.has(id)) throw new TypeError(`duplicate loader entry id: ${id}`);
      seen.add(id);
    }
    const oldMap = Object.fromEntries(oldConfig.map(options => [options.id, options]));
    const newMap = Object.fromEntries(config.map(options => [options.id, options]));
    this.data = config;
    return { oldMap, newMap };
  }
}

async function main() {
  const group = new EntryGroup();
  await group.update([
    { id: "fujiang-armor", name: "fujiang-armor", config: { enabled: true, level: 2 } },
    { config: { level: 2, enabled: true }, name: "fujiang-armor", id: "fujiang-armor" },
  ]);
  if (group.data.length !== 1) throw new Error("identical duplicate was not collapsed");
  if (group.data[0].id !== "fujiang-armor") throw new Error("wrong entry survived");

  let conflictRejected = false;
  try {
    await group.update([
      { id: "same-id", name: "plugin-a", config: { mode: "a" } },
      { id: "same-id", name: "plugin-b", config: { mode: "b" } },
    ]);
  } catch (error) {
    conflictRejected = /duplicate loader entry id: same-id/.test(String(error));
  }
  if (!conflictRejected) throw new Error("conflicting duplicate must remain fail-loud");
}
main();
JS

printf '%s\n' '- insert:' '  - id: fujiang-armor' '    name: fujiang-armor' > "$TMP/home/.dsh/profiles/web/cordis.patch.yml"
BEFORE="$(sha256sum "$TMP/home/.dsh/profiles/web/cordis.patch.yml" | awk '{print $1}')"

# Save original source to exercise more than one loader export form.
cp "$PKG/lib/index.js" "$TMP/loader-pristine.js"

# Check real rc.2 loader shape before the expensive native build.
DSH_COMPAT_PREFLIGHT_ONLY=1 DSH_TARGET_VERSION=0.1.5-rc.2 \
  node "$PATCH" "$TMP/usr" >/dev/null 2>"$TMP/preflight-before.stderr"

# Keep unrelated mandatory patches off while exercising the discovered loader.
DSH_TARGET_VERSION=0.1.0 node "$PATCH" "$TMP/usr" >/dev/null 2>"$TMP/patch.stderr"
node --check "$PKG/lib/index.js"
node "$PKG/lib/index.js"
# A transpiled "var EntryGroup = class" is a different published form.
ALT="$TMP/alt/usr/lib/node_modules/@deepseek-ai/cordis-plugin-loader"
mkdir -p "$ALT/lib"
cp "$PKG/package.json" "$ALT/package.json"
sed 's/^class EntryGroup {/var EntryGroup = class {/' "$TMP/loader-pristine.js" > "$ALT/lib/index.js"
DSH_COMPAT_PREFLIGHT_ONLY=1 DSH_TARGET_VERSION=0.1.5-rc.2 \
  node "$PATCH" "$TMP/alt/usr" >/dev/null 2>"$TMP/alt-preflight.stderr"
DSH_TARGET_VERSION=0.1.0 node "$PATCH" "$TMP/alt/usr" >/dev/null 2>"$TMP/alt-patch.stderr"
node --check "$ALT/lib/index.js"
node "$ALT/lib/index.js"

AFTER="$(sha256sum "$TMP/home/.dsh/profiles/web/cordis.patch.yml" | awk '{print $1}')"
[ "$BEFORE" = "$AFTER" ] || { echo "[FAIL] user profile data was modified" >&2; exit 1; }

echo "[OK] identical duplicate loader entries collapse; conflicting duplicates still fail; user profile untouched"
