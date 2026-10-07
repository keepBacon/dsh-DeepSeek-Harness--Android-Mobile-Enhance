#!/data/data/com.termux/files/usr/bin/bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PATCH="$ROOT/scripts/android-runtime-patch.mjs"
ENGINE="$ROOT/app/src/main/java/com/dshmobile/shell/EngineManager.kt"

must() {
  local file="$1" needle="$2"
  grep -Fq -- "$needle" "$file" || { echo "[FAIL] missing in $file: $needle" >&2; exit 1; }
}

must "$PATCH" "@deepseek-ai/dsh-tools"
must "$PATCH" "DSH Android compat: legacy tool output schema fail-soft"
must "$PATCH" "normalized legacy output schema for tool"
must "$PATCH" 'androidSchemaError.code === "UNSUPPORTED_SCHEMA"'

# Current main already uses a stronger data-safe runtime transaction than the
# earlier direct-extraction design: the archive is extracted into a private
# stage, existing HOME is authoritative, and only usr/ is swapped.
must "$ENGINE" 'private fun shouldPreserveUserHome()'
must "$ENGINE" 'val stageRoot = File(context.filesDir, ".runtime-stage-"'
must "$ENGINE" 'Existing user HOME is authoritative'
must "$ENGINE" 'seedHomeFromStage(stageHome)'
must "$ENGINE" 'HOME and public DSH data are never'

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
PKG="$TMP/usr/lib/node_modules/@deepseek-ai/dsh-tools"
mkdir -p "$PKG/lib"
cat > "$PKG/package.json" <<'JSON'
{"name":"@deepseek-ai/dsh-tools","version":"0-test"}
JSON
cat > "$PKG/lib/index.js" <<'JS'
function assertSupportedJsonSchema(schema) {
  const allowed = new Set(["object", "array", "string", "number", "integer", "boolean", "null"]);
  if (Object.prototype.hasOwnProperty.call(schema, "type") && !allowed.has(schema.type)) {
    const error = new Error("unsupported JSON schema: schema.type must be one of object/array/string/number/integer/boolean/null");
    error.code = "UNSUPPORTED_SCHEMA";
    throw error;
  }
}
class ToolRuntime {
  register(definition) {
    const name = definition.name;
    const output = definition.output;
    assertSupportedJsonSchema(output.schema);
    return definition;
  }
}
const original = { type: "json", description: "legacy arbitrary JSON" };
const registered = new ToolRuntime().register({ name: "legacy_test", output: { schema: original, render() {} } });
if (registered.output.schema.type !== undefined) throw new Error("legacy type was not normalized");
if (registered.output.schema.description !== original.description) throw new Error("annotations were not preserved");
if (original.type !== "json") throw new Error("plugin-owned schema was mutated");
JS

# 0.1.0 keeps unrelated package patches optional while still exercising any
# discovered dsh-tools instance.
DSH_TARGET_VERSION=0.1.0 node "$PATCH" "$TMP/usr" >/dev/null 2>"$TMP/patch.stderr"
node --check "$PKG/lib/index.js"
node "$PKG/lib/index.js"

echo "[OK] legacy tool output schema compatibility + staged HOME preservation"
