from pathlib import Path

em = Path("app/src/main/java/com/dshmobile/shell/EngineManager.kt")
s = em.read_text()

old = '''  private val nodeCacheDir = File(homeDir, ".cache").apply { mkdirs() }
  private val nodeCompileCacheDir = File(nodeCacheDir, "node-compile").apply { mkdirs() }
'''
new = '''  private val nodeCacheDir = File(homeDir, ".cache").apply { mkdirs() }
  private val nodeCompileCacheDir = File(nodeCacheDir, "node-compile").apply { mkdirs() }
  private val androidRecoveryDir = File(homeDir, ".dsh/android-recovery")
  private val androidSafeBootPatchFile = File(androidRecoveryDir, "safe-boot.patch.yml")
'''
if old not in s:
    raise SystemExit("EngineManager cache-field anchor missing")
s = s.replace(old, new, 1)

old = '''      val args = arrayOf(
        nodeBin.absolutePath, "--expose-internals", dshBin.absolutePath,
        "web", "--port", port.toString(), "--no-open",
      )
'''
new = '''      val args = mutableListOf(
        nodeBin.absolutePath, "--expose-internals", dshBin.absolutePath,
        "web",
      )
      // The emergency overlay is created only after a verified composition
      // failure. It is applied last, so a broken community bundle cannot keep
      // the permission service in an unbootable custom-default state.
      if (androidSafeBootPatchFile.isFile) {
        args += listOf("--patch", androidSafeBootPatchFile.absolutePath)
      }
      args += listOf("--port", port.toString(), "--no-open")
'''
if old not in s:
    raise SystemExit("EngineManager start args anchor missing")
s = s.replace(old, new, 1)

anchor = '''  /** Public/profile-aware config path. The public copy is authoritative after migration. */
  fun profilePatchFile(profile: String = "web"): File {
'''
block = r'''  /**
   * Last-resort Android recovery after the Host itself proves the composed
   * plugin tree cannot boot. No session, settings, attachment, workspace or
   * credential data is deleted here.
   *
   * Permission-preset mismatch gets the narrowest repair: an Android-owned
   * final --patch overlay that restores the upstream-safe preset table and an
   * explicit workspace-write default. Other plugin-tree boot failures enter
   * bundle safe mode by retaining only the two shipped Web layers. Installed
   * packages stay on disk and the original manifest is timestamp-backed up.
   */
  fun recoverFromBootFailure(profile: String = "web"): PluginCommandResult {
    val diag = engineDiagnostics(20_000)
    val permissionMismatch =
      diag.contains("composed sandbox and approval defaults match no preset", ignoreCase = true) ||
      diag.contains("configure defaultPreset explicitly", ignoreCase = true)
    val pluginTreeFailure =
      diag.contains("plugin tree failed to load", ignoreCase = true) ||
      diag.contains("failed to apply loader entry", ignoreCase = true)

    if (!permissionMismatch && !pluginTreeFailure) {
      return PluginCommandResult(false, -1, "当前故障不是可安全自动修复的 profile/plugin 组合错误。")
    }

    return try {
      androidRecoveryDir.mkdirs()
      if (permissionMismatch) {
        val patch = """# Android automatic DSH boot recovery.
# This file is intentionally separate from the user's cordis.patch.yml.
- id: permission
  config:
    defaultPreset: workspace-write
    presets:
      read-only:
        sandbox: read-only
        approval: ask
      workspace-write:
        sandbox: workspace-write
        approval: ask
      danger-full-access:
        sandbox: danger-full-access
        approval: never
"""
        writeTextAtomic(androidSafeBootPatchFile, patch)
        PluginCommandResult(
          true, 0,
          "检测到 permission preset 组合冲突；已启用 Android 安全启动覆盖层。聊天记录、模型 Key、设置与插件文件均未删除。",
        )
      } else {
        disableNonCoreBundles(profile)
      }
    } catch (t: Throwable) {
      PluginCommandResult(false, -3, "自动恢复失败：" + (t.message ?: t.javaClass.simpleName))
    }
  }

  /**
   * Emergency bundle safe mode. Unlike the older startsWith("@deepseek-ai/")
   * heuristic, this keeps only the exact shipped Web profile layers. A user can
   * install experimental/first-party-named bundles too, so namespace alone is
   * not a reliable trust boundary.
   */
  private fun disableNonCoreBundles(profile: String = "web"): PluginCommandResult {
    val manifest = profileManifest(profile)
    if (!manifest.isFile) return PluginCommandResult(false, -1, "web profile 尚未初始化")
    return try {
      val original = manifest.readText()
      val root = JSONObject(original)
      val dsh = root.optJSONObject("dsh") ?: return PluginCommandResult(false, -1, "profile 缺少 dsh 配置")
      val profileObject = dsh.optJSONObject("profile") ?: return PluginCommandResult(false, -1, "profile 缺少 bundle 配置")
      val old = profileObject.optJSONArray("bundles") ?: JSONArray()
      val core = setOf("@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app")
      val next = JSONArray()
      val disabled = mutableListOf<String>()
      for (i in 0 until old.length()) {
        val name = old.optString(i)
        if (name in core) next.put(name) else if (name.isNotBlank()) disabled += name
      }
      androidRecoveryDir.mkdirs()
      val backup = File(androidRecoveryDir, "web-package-" + System.currentTimeMillis() + ".json")
      backup.writeText(original)
      profileObject.put("bundles", next)
      writeTextAtomic(manifest, root.toString(2) + "\n")
      PluginCommandResult(
        true, 0,
        if (disabled.isEmpty()) {
          "检测到 plugin tree 启动故障；当前没有可停用的非核心 bundle。"
        } else {
          "检测到 plugin tree 启动故障；已进入安全模式并停用：" + disabled.joinToString(", ") + ".\n" +
            "插件安装文件未删除，原 profile manifest 已备份到 " + backup.absolutePath + "。聊天记录、模型 Key 与设置保持不变。"
        },
      )
    } catch (t: Throwable) {
      PluginCommandResult(false, -3, t.message ?: t.javaClass.simpleName)
    }
  }

'''
if anchor not in s:
    raise SystemExit("EngineManager recovery insert anchor missing")
s = s.replace(anchor, block + anchor, 1)
em.write_text(s)

ma = Path("app/src/main/java/com/dshmobile/shell/MainActivity.kt")
s = ma.read_text()

old = '''        runOnUiThread { showStartingState("正在启动 DSH 引擎…", "首次启动或插件较多时可能需要一些时间。") }
        if (!engineManager.startEngine(runtimeAlreadyChecked = true)) {
          runOnUiThread { showEngineFailure("引擎启动失败") }
          return@Thread
        }

        // Poll aggressively during the first few seconds. A 1 s fixed polling
        // interval added ~500 ms average latency after the HTTP listener was
        // already ready. Also stop immediately if the child process dies.
        if (waitForEngineReady()) {
          startEngineService()
          applyShizukuKeepAlive()
          runOnUiThread { showWeb() }
          return@Thread
        }
        runOnUiThread {
          showEngineFailure(if (engineManager.isEngineProcessAlive()) "引擎启动超时" else "引擎启动后退出")
        }
'''
new = '''        runOnUiThread { showStartingState("正在启动 DSH 引擎…", "首次启动或插件较多时可能需要一些时间。") }
        var started = engineManager.startEngine(runtimeAlreadyChecked = true)
        var running = started && waitForEngineReady()

        // A broken plugin/config must not permanently lock the user out of
        // sessions, settings or credentials. Recover only after the Host has
        // produced a recognized plugin-tree failure, then retry once.
        if (!running) {
          val recovery = engineManager.recoverFromBootFailure()
          if (recovery.ok) {
            runOnUiThread {
              showStartingState("正在自动恢复 DSH…", recovery.output)
            }
            engineManager.stopEngine()
            started = engineManager.startEngine(runtimeAlreadyChecked = true)
            running = started && waitForEngineReady(45_000L)
          }
        }

        if (running) {
          startEngineService()
          applyShizukuKeepAlive()
          runOnUiThread { showWeb() }
          return@Thread
        }
        runOnUiThread {
          showEngineFailure(if (engineManager.isEngineProcessAlive()) "引擎启动超时" else "引擎启动后退出")
        }
'''
if old not in s:
    raise SystemExit("MainActivity startup anchor missing")
s = s.replace(old, new, 1)

old = '''        val started = engineManager.startEngine()
        if (started) running = waitForEngineReady()
        if (running) {
          startEngineService()
          applyShizukuKeepAlive()
        }
'''
new = '''        var started = engineManager.startEngine()
        if (started) running = waitForEngineReady()
        if (!running) {
          val recovery = engineManager.recoverFromBootFailure()
          if (recovery.ok) {
            result = result.copy(
              output = listOf(result.output.trim(), "[Android 自动恢复] " + recovery.output)
                .filter { it.isNotBlank() }
                .joinToString("\\n\\n"),
            )
            engineManager.stopEngine()
            started = engineManager.startEngine(runtimeAlreadyChecked = true)
            if (started) running = waitForEngineReady(45_000L)
          }
        }
        if (running) {
          startEngineService()
          applyShizukuKeepAlive()
        }
'''
if old not in s:
    raise SystemExit("MainActivity mutation restart anchor missing")
s = s.replace(old, new, 1)
ma.write_text(s)

check = Path("scripts/check-remaining-fixes.sh")
s = check.read_text()
anchor = '''must "$MA" 'setOnClickListener { openExternalUrl(GITHUB_REPOSITORY_URL) }'
'''
extra = '''must "$MA" 'engineManager.recoverFromBootFailure()'
must "$EM" 'fun recoverFromBootFailure(profile: String = "web"): PluginCommandResult'
must "$EM" 'androidSafeBootPatchFile'
must "$EM" 'defaultPreset: workspace-write'
must "$EM" 'setOf("@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app")'
must "$EM" '"--patch", androidSafeBootPatchFile.absolutePath'
'''
if anchor not in s:
    raise SystemExit("check script anchor missing")
s = s.replace(anchor, anchor + extra, 1)
check.write_text(s)

changelog = Path("CHANGELOG.md")
s = changelog.read_text()
note = "- 修复插件安装/启用后可能导致 DSH 永久无法启动：识别 plugin-tree/permission-preset 启动故障后自动安全恢复；permission 冲突使用独立末级覆盖层，其他 bundle 故障仅停用非核心层并备份 manifest，绝不删除聊天记录、模型 Key、settings、sessions、attachments 或已安装插件文件。\\n"
if note not in s:
    s = note + s
changelog.write_text(s)
