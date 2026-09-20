#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MA="$ROOT/app/src/main/java/com/dshmobile/shell/MainActivity.kt"
EM="$ROOT/app/src/main/java/com/dshmobile/shell/EngineManager.kt"
AB="$ROOT/app/src/main/java/com/dshmobile/shell/AndroidBridge.kt"
SC="$ROOT/app/src/main/java/com/dshmobile/shell/SecureCredentialStore.kt"
MF="$ROOT/app/src/main/AndroidManifest.xml"
BG="$ROOT/app/build.gradle.kts"
BT="$ROOT/build-termux.sh"
BP="$ROOT/build-termux-desktop-parity.sh"
SHI="$ROOT/app/src/main/java/com/dshmobile/shell/ShizukuSupport.kt"
SE="$ROOT/app/src/main/java/com/dshmobile/shell/SnapshotExtractor.kt"
EP="$ROOT/app/src/main/java/com/dshmobile/shell/EngineProbe.kt"
ES="$ROOT/app/src/main/java/com/dshmobile/shell/EngineService.kt"

fail() { echo "[FAIL] $*" >&2; exit 1; }
must() { grep -Fq "$2" "$1" || fail "missing in $(basename "$1"): $2"; }
forbid() { ! grep -Fq "$2" "$1" || fail "forbidden in $(basename "$1"): $2"; }

# M-01 workspace import publication must never use a check-then-rename overwrite path.
must "$MA" 'Files.createLink(candidate.toPath(), temp.toPath())'
must "$MA" 'if (!candidate.createNewFile()) continue'
forbid "$MA" 'uniqueWorkspaceDestination'

# M-02/M-03 archive abuse limits.
must "$MA" 'MAX_PLUGIN_PACKAGE_BYTES = 512L * 1024 * 1024'
must "$MA" 'MAX_PLUGIN_ZIP_ENTRY_BYTES = 256L * 1024 * 1024'
must "$MA" 'MAX_PLUGIN_ZIP_ENTRIES = 20_000'
must "$MA" 'MAX_PLUGIN_ZIP_DEPTH = 32'
must "$MA" 'copyWithLimit(input, output, MAX_PLUGIN_PACKAGE_BYTES'

# M-04 plain dependencies are classified and cannot be toggled as bundles.
must "$EM" 'val bundle: Boolean'
must "$EM" 'packageDeclaresBundle(name, profile)'
must "$EM" '没有声明 dsh.bundle.patch，不能作为 profile 层启用'
must "$MA" 'isEnabled = info.bundle'

# M-05/M-06 mobile shim must be event/mutation driven, not polling/full-body text scanning.
forbid "$MA" 'body.innerText'
forbid "$MA" 'setInterval(sync'
must "$MA" 'const mutationRelevant = (mutation) => {'
must "$MA" 'if (mutations.some(mutationRelevant)) schedule();'

# M-07/M-08 storage roots and legacy Android support.
must "$AB" 'if (volume == "primary" && rel.isEmpty()) return "/storage/emulated/0"'
must "$AB" 'val root = java.io.File("/storage/$volume")'
must "$MF" 'android.permission.READ_EXTERNAL_STORAGE'
must "$MF" 'android.permission.WRITE_EXTERNAL_STORAGE'
must "$MF" 'android:requestLegacyExternalStorage="true"'
must "$MA" 'resolveWritableWorkspacePath(uri)'
must "$MA" 'MediaStore.Downloads.EXTERNAL_CONTENT_URI'
must "$MA" 'reserveUniqueFile(root, filename)'

# M-09/M-10 encrypted SSH/Git credentials and exact host-scoped askpass.
must "$SC" 'AndroidKeyStore'
must "$SC" 'AES/GCM/NoPadding'
must "$EM" 'SSH_ASKPASS_REQUIRE'
must "$EM" 'GIT_ASKPASS'
must "$EM" 'DSH_GIT_AUTH_HOST" ] || exit 1'
must "$MA" '.id_dsh-import-${java.util.UUID.randomUUID()}.tmp'

# M-11/M-12 queues: downloads and permission-delayed notifications are not silently dropped.
forbid "$MA" 'exportDownloading'
must "$MA" 'ConcurrentLinkedQueue<DownloadRequest>()'
must "$MA" 'ConcurrentLinkedQueue<PendingNotification>()'
must "$MA" 'val pending = pendingNotifications.poll() ?: break'

# M-13/M-14 build correctness.
must "$BP" 'DSH_CHANNEL:-stable'
must "$BP" 'exec bash "$ROOT/build-parity-termux.sh"'
forbid "$BT" 'cp -a "$host_prefix/include/node"'
must "$BT" 'cp -RL --preserve=mode,timestamps "$host_prefix/include/node" "$headers/include/node"'

# L-01/L-02/L-03 UI/copy diagnostics.
forbid "$SHI" '保活增强就绪'
must "$SHI" '当前仅检测状态，未应用额外保活策略'
must "$MA" 'const upstreamSettingsIcon = () => {'
must "$MA" 'appSettings.innerHTML = upstreamSettingsIcon();'
forbid "$BG" 'snapshot-x86_64.tar.xz'
must "$BG" 'snapshot-arm64.tar.xz'

# V0.1 identity and settings repository entry.
must "$BG" 'versionCode = 35'
must "$BG" 'versionName = "0.1"'
must "$MA" 'DSH-Android/0.1'
must "$BT" '"app": "0.1"'
must "$BT" "printf 'app=0.1\\ndsh=%s\\nsha256=%s\\n'"
must "$MA" 'GITHUB_REPOSITORY_URL = "https://github.com/keepBacon/dsh-DeepSeek-Harness--Android-Mobile-Enhance"'
must "$MA" 'text = "版本  V0.1"'
must "$MA" 'text = "GitHub 仓库\n$GITHUB_REPOSITORY_URL"'
must "$MA" 'setOnClickListener { openExternalUrl(GITHUB_REPOSITORY_URL) }'
SKM="$ROOT/app/src/main/java/com/dshmobile/shell/SkillManager.kt"
must "$MA" "const SKILL_NAV_ID = 'dsh-android-skill-settings-nav'"
must "$MA" "const SKILL_PANEL_ID = 'dsh-android-skill-settings-panel'"
must "$MA" 'window.androidBridge.listSkills(BRIDGE_CAP)'
must "$MA" 'window.androidBridge.openSkillImporter(BRIDGE_CAP)'
must "$MA" 'window.androidBridge.deleteSkill(BRIDGE_CAP, storageKey)'
must "$MA" "dsh-android-skills-changed"
must "$AB" 'fun listSkills(capability: String): String'
must "$AB" 'fun deleteSkill(capability: String, name: String): String'
must "$AB" 'fun openSkillImporter(capability: String)'
must "$SKM" 'class SkillManager('
must "$SKM" 'File(engineManager.ensureDshDataHome(), "skills")'
must "$SKM" 'fun importUri(uri: Uri): String'
must "$SKM" 'fun listJson(): String'
must "$SKM" 'fun deleteJson(storageKey: String): String'
must "$SKM" 'Skill ZIP 路径越界'
must "$SKM" 'Files.isSymbolicLink'
must "$MA" 'engineManager.recoverFromBootFailure()'
must "$EM" 'fun recoverFromBootFailure(profile: String = "web"): PluginCommandResult'
forbid "$EM" 'disableNonCoreBundles'
forbid "$EM" 'androidSafeBootPatchFile'
must "$EM" '不会自动停用、删除或改写任何 bundle'
must "$ROOT/scripts/android-runtime-patch.mjs" "'@deepseek-ai/dsh-permission-presets'"
must "$ROOT/scripts/android-runtime-patch.mjs" 'DSH Android compat: preserve composed permission defaults'
must "$ROOT/scripts/android-runtime-patch.mjs" '__dsh_android_composed_default__'
must "$ROOT/scripts/android-runtime-patch.mjs" 'sandbox: ctx.shell.sandboxMode'
must "$ROOT/scripts/android-runtime-patch.mjs" 'approval: ctx.approval.config.policy ?? "ask"'
forbid "$ROOT/scripts/android-runtime-patch.mjs" 'DSH Android compat: explicit permission default preset'

# V0.1 runtime extraction / engine-start performance.
must "$SE" 'COPY_BUFFER_SIZE = 256 * 1024'
must "$SE" 'PROGRESS_STEP_BYTES = 4L * 1024L * 1024L'
must "$SE" 'safeDirectories = HashSet<Path>(4096)'
must "$SE" 'ProcessBuilder(base + batch)'
must "$SE" 'Os.chmod(file.absolutePath, if (executable) 448 else 384)'
must "$EM" '"NODE_COMPILE_CACHE" to nodeCompileCacheDir.absolutePath'
must "$EM" 'waitFor(80, TimeUnit.MILLISECONDS)'
must "$EM" 'fun isEngineProcessAlive(): Boolean'
must "$MA" 'private fun waitForEngineReady(timeoutMs: Long = 60_000L): Boolean'
must "$MA" 'EngineProbe.check(250)'
must "$ES" 'EngineProbe.check(350)'
must "$EP" 'MAX_PROBE_BODY = 16 * 1024'
must "$BT" 'DSH_XZ_PRESET="${DSH_XZ_PRESET:-0}"'
must "$BT" 'XZ_OPT="-$DSH_XZ_PRESET" tar -cJf'

# Syntax/regression checks.
for f in "$ROOT"/build*.sh "$ROOT"/scripts/*.sh; do bash -n "$f"; done
node --check "$ROOT/scripts/android-runtime-patch.mjs" >/dev/null
python - "$ROOT" <<'PY'
from pathlib import Path
import sys, textwrap, xml.etree.ElementTree as ET, subprocess, tempfile
root=Path(sys.argv[1])
ET.parse(root/'app/src/main/AndroidManifest.xml')
ET.parse(root/'app/src/main/res/xml/network_security_config.xml')
source=(root/'app/src/main/java/com/dshmobile/shell/MainActivity.kt').read_text()
pos=0
scripts=[]
needle='val script = """'
endneedle='""".trimIndent()'
while True:
    start=source.find(needle,pos)
    if start<0: break
    body_start=start+len(needle)
    end=source.find(endneedle,body_start)
    if end<0: raise SystemExit('[FAIL] unterminated injected JS string')
    body=textwrap.dedent(source[body_start:end])
    body=body.replace('${jsString(uiMode)}','"mobile"').replace('${jsString(capability)}','"STATIC_CHECK_CAP"')
    scripts.append(body)
    pos=end+len(endneedle)
for idx,body in enumerate(scripts,1):
    with tempfile.NamedTemporaryFile('w',suffix='.js',delete=False) as f:
        f.write(body); name=f.name
    p=subprocess.run(['node','--check',name],capture_output=True,text=True)
    Path(name).unlink(missing_ok=True)
    if p.returncode:
        raise SystemExit(f'[FAIL] injected JS #{idx}: {p.stderr}')
# Validate the exact helper-shell bodies embedded in Kotlin.
em=(root/'app/src/main/java/com/dshmobile/shell/EngineManager.kt').read_text()
import re, os
match=re.search(r'ensureHelperScript\("git-askpass\.sh", """(.*?)"""\)', em, re.S)
if not match:
    raise SystemExit('[FAIL] git askpass helper not found')
helper=textwrap.dedent(match.group(1)).strip().replace("${'$'}", '$') + '\n'
with tempfile.NamedTemporaryFile('w',suffix='.sh',delete=False) as f:
    f.write('#!/bin/sh\n'+helper); helper_path=f.name
os.chmod(helper_path,0o700)
try:
    syntax=subprocess.run(['sh','-n',helper_path],capture_output=True,text=True)
    if syntax.returncode:
        raise SystemExit('[FAIL] git askpass shell syntax: '+syntax.stderr)
    env={**os.environ,'DSH_GIT_AUTH_HOST':'github.com','DSH_GIT_AUTH_USERNAME':'x-access-token','DSH_GIT_AUTH_TOKEN':'secret'}
    good=subprocess.run([helper_path,"Username for 'https://github.com':"],env=env,capture_output=True,text=True)
    if good.returncode or good.stdout.strip()!='x-access-token':
        raise SystemExit('[FAIL] git askpass valid-host test failed')
    evil=subprocess.run([helper_path,"Password for 'https://github.com.evil.example':"],env=env,capture_output=True,text=True)
    if evil.returncode==0:
        raise SystemExit('[FAIL] git askpass leaked credential to suffix host')
finally:
    Path(helper_path).unlink(missing_ok=True)
print(f'[OK] parsed XML + checked {len(scripts)} injected JS blocks + askpass helper')
PY

echo '[OK] remaining medium/low regression checks passed'
