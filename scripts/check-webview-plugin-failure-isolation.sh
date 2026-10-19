#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MAIN="$ROOT/app/src/main/java/com/dshmobile/shell/MainActivity.kt"
ENGINE="$ROOT/app/src/main/java/com/dshmobile/shell/EngineManager.kt"
grep -Fq 'if (!request.isForMainFrame || !isEngineSource(url))' "$MAIN"
grep -Fq 'Non-main-frame resource failed (no Host restart)' "$MAIN"
grep -Fq 'if (Build.VERSION.SDK_INT >= 23) return' "$MAIN"
grep -Fq 'private fun monitorPluginPageStall(view: WebView)' "$MAIN"
grep -Fq 'private fun confirmPluginFailureRecovery()' "$MAIN"
grep -Fq 'runProfileMutation("正在隔离故障插件…")' "$MAIN"
grep -Fq 'engineManager.disableAllUserPluginsForRecovery()' "$MAIN"
grep -Fq 'val backups = mutableListOf<Pair<File, File>>()' "$ENGINE"
grep -Fq 'if (name.startsWith("@deepseek-ai/")) retained.put(name)' "$ENGINE"
echo '[DSH] WebView plugin-failure isolation and native recovery: OK'
