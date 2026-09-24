- 修复真实 Web smoke test 的认证协议错误：DSH 0.1.5-rc.2 的根页面不是公开资源，裸 `GET /` 按设计必须返回 401；只有进程打印的 `/?token=<launch-token>` 可进行一次 303 token→cookie 交换，之后携带 authority-bound 签名 Cookie 才能读取 index。旧 smoke test 用裸 `curl /` 判断 readiness（curl 对 401 仍返回成功）并随后直接 `fetch('/')`，因此在健康 Web Host 上必然误报 `index HTTP 401`。现改为等待真实 `dsh web: ...?token=...` readiness 行，严格验证 `401 → 303 + Set-Cookie → authenticated 200`，再用同一 Cookie 验证 __DSH_BOOT__ 与全部单资源 client bundles；等待窗口同步扩到 90 秒。未降低认证要求，也未绕过 401。
- 修复 Web profile 启动阶段 `user patch-layer watching requires the Cordis HMR service` / 随后 `ECONNREFUSED 127.0.0.1:<port>`：根因收敛到 vendor runtime identity，而非端口。DSH 0.1.5-rc.2 源码对应的 Cordis vendor family 现在按 release commit 精确锁定（Cordis 4.0.2、HMR 1.0.17、Loader 1.0.3、Timer 1.1.4、Include 1.0.7、Group 1.0.2、Cosmokit 1.8.3、Schemastery 3.18.2 等），这些包同时作为顶层精确依赖和 npm overrides 参与同一份 lock。package-lock 阶段要求恰好一个 Cordis 解析实例；安装后再按物理 realpath 扫描，出现第二份 Cordis 即拒绝打包，避免 HMR/Loader 把服务注册到另一套 Cordis runtime。真实 Web/HMR smoke test 保留，不绕过错误；`ECONNREFUSED` 仍作为进程提前退出的次生故障被拒绝。该改动只影响构建期 Runtime，不触碰用户 HOME、会话、工作区或 API Key。
- 根治 DSH 0.1.5-rc.2 npm release-family 版本漂移：上游 GitHub release commit `a30530342297e6006623a775166fee1d14fd413a` 要求整个 DSH family 同版本，但 registry 解析曾把 rc.2 根包指向 rc.3 内部包（已观察到 `dsh-sdk-protocol@^0.1.5-rc.3` 与 `dsh-session-format-v0-to-v1@^0.1.5-rc.3`），造成 ETARGET 或 rc.2/rc.3 混装。Android 构建现内置由该 GitHub release commit 生成的 family lock，使用 npm `overrides` 固定全部 DSH family 为 rc.2；先在隔离目录生成并验证 package-lock，再仅从一个通过验证的 registry 用 `npm ci` 安装到全新 node_modules；安装后再次扫描所有 `@deepseek-ai/dsh*` 版本，发现未知包或版本漂移立即失败。registry fallback 不再污染同一个 Runtime 前缀，并记录 source commit / registry / lock SHA-256 到 Runtime manifest。
- 修正上一版 Android Web client 补丁的错误锚点：npm 发布的 `dsh-client-modules/lib/client.js` 已被打包转换，源码级 `initialUrl` 结构不存在。现改为补丁发布包中稳定的 Host 端 `lib/index.js`：Android 下 `comboUrl()` 对单条资源生成直接 `/plugins/<package>/client.js?rev=...` 路径，`partitionComboRecords()` 强制每批一条，从协议层避开非默认 prefix 下不稳定的 `/plugins/??...` combo route。真实 Web smoke test 新增硬断言：graph 的 batches/entries 只要仍出现 `/??` 就拒绝打包。仍不读写或删除用户 HOME、会话、工作区、API Key、插件清单。
- 修复 Android Web GUI 大量 `failed to import loader entry` / `client-modules: bundle script /plugins/??...` 连锁失败：对尚未包含上游 batch 重试/逐条 fallback 的 DSH 版本，Android Runtime 将初始 client 加载收敛到每个插件已有的单资源 URL，避免一个 application combo 传输失败拖垮整页；构建验收进一步真实启动 `dsh web` 并逐个 HTTP 拉取全部 client bundle，任一 404/空包/截断包都会直接拒绝生成 APK。该修复仅修改内置 Runtime 与构建检查，不删除、不重建、不覆盖 `$HOME/.dsh`、会话、工作区、API Key、插件清单或公共数据目录。
- 杜绝“APK 能构建但 DSH 核心插件树启动即崩”的假健康 Runtime：恢复 DSH 必需 peerDependencies 的正常安装，仅通过 npm 日志级别抑制 ERESOLVE 刷屏；打包前新增真实 `dsh web` 启动级 Cordis/core plugin tree smoke test，核心插件无法 resolve 时直接拒绝生成 APK；设备端若检测到多个 `@deepseek-ai/dsh-*` 核心插件同时加载失败，会自动事务式重建内置 `/usr` 一次，HOME/会话/配置/API Key/插件清单均不删除。
- 修复 StepFun Plan 兼容补丁再次因 `supportsFinishReason` 在实际 pi-ai 发布包中不存在而阻断构建：删除对 `@earendil-works/pi-ai` 内部实现的脆弱改写，改在 DSH 自有 `dsh-llm-pi-ai` 适配层仅对 `stepfun-plan` 的已产生内容 + 已知 EOF 诊断归一化为正常 stop/tool-calls；其他 Provider 与真实网络中断仍按原逻辑失败/重试。
- 优化 Runtime npm 源回退：主源安装失败后不再对同一源固定等待 3 秒并重复一次，而是直接切换已配置备用源；解决 `ETARGET` 这类确定性缺包错误产生重复失败输出和无意义等待。
- 修复 StepFun Plan Android Runtime 补丁在 `pi-ai 0.85.1` 上因全文件重复 compat 字段误判锚点变化而中止构建：锚点与替换现严格限定在 `detectCompat(model)` 函数内部，仍保持上游结构变化时 fail-closed。
- 修复 Termux 完整构建期间 npm 持续刷 `ERESOLVE overriding peer dependency`：Runtime bootstrap 的全局 npm 安装改用 `--legacy-peer-deps`，与 Android profile 的 `autoInstallPeers=false` 策略保持一致，避免 DSH 预发布 peer 依赖触发反复回溯解析。
- 修复 StepFun Plan 流式请求反复出现 `upstream stream ended before a completion event` 并重试到 5/5：Android Runtime 仅对 `stepfun-plan` / `/step_plan/` 端点启用 OpenAI-compatible 专用兼容默认值（`max_tokens`、禁用 store/developer role/stream usage/strict schema，并允许缺少 `finish_reason` 时由流结束推断完成）；其他 Provider 继续保持严格的流完整性检查。
- 应用设置新增工作区导入：支持系统文件选择器一次多选文件，以及内置共享存储浏览器跨目录勾选多个文件/文件夹后批量递归复制到当前 DSH 工作区；导入不会切换工作区，包含同名避让、符号链接拒绝、层级/项目数限制与工作区递归保护。
- 修复 Runtime 首次解压/修复因 Termux 包绝对符号链接而失败：`/data/data/com.termux/files/usr/...` 形式的 archive symlink 会安全重定位到应用自身 `files/usr` 内的相对链接；任意其他绝对链接仍拒绝。
- Runtime 修复改为事务式：先完整解压到 `.runtime-stage-*` 并校验，之后才备份并替换 live `usr`；提交失败会自动回滚旧 `usr`，用户 HOME、会话、模型 Key、插件/Skill 数据不参与运行时替换。
- 构建阶段新增 snapshot symlink 规范化，打包前消除旧 Termux prefix 的绝对链接，从源头避免 APK 首次解压再次触发同类故障。
- 修复完整 Termux 工具打包在“Bundling Termux tool/package-manager closure”后静默退出：包 payload 覆盖时不再跟随 snapshot 中的绝对/旧符号链接写入目标，先按类型安全替换目标节点；同时增加逐包进度与 ERR trap，未来构建失败会直接打印行号、退出码和具体命令。
- Runtime 工具环境增强：完整构建现在打包 Termux 兼容的 `pkg` / `apt` / `dpkg`、Python3 / pip 与常用 CLI 工具。由于 Termux 包通常绑定 `/data/data/com.termux/files/usr`，应用通过 PRoot 兼容命名空间将本应用私有 `files/usr` 映射到该前缀；包管理器写入仍落在本应用私有目录。构建时会验证 Python、pip、dpkg、apt 与 pkg 可执行。
- 终端可用性根因修复：Runtime 现在打包真实 Termux Bash 到 `usr/libexec/dsh/bash-real`，以 `/system/bin/sh` 包装器暴露稳定的 `usr/bin/bash`/`usr/bin/sh`，Host 强制设置 `DSH_SIDEBAR_SHELL`/`SHELL` 指向内置 Bash；完整构建会实际用 node-pty spawn Bash 并执行命令，失败则拒绝产出 APK。
# V0.1.1 — Compatibility & Stability Update

- 应用版本升级为 `V0.1.1`（`versionName=0.1.1`, `versionCode=36`）。
- 继续保留当前 Android DSH Runtime、插件兼容、Skill 管理、运行时数据保护与移动端设置界面修复。
- Runtime 元数据、WebView User-Agent 与“关于”页版本信息同步更新为 `0.1.1`。

- 修复 DSH 启动阶段 pnpm workspace 空映射检测的 RegexSyntaxException：移除动态正则对 `overrides: {}` / `allowBuilds: {}` 的匹配，改为注释剥离后的精确字符串判断，避免兼容层自身阻断引擎启动。
- Skill ZIP 导入新增集合文件夹：每个 ZIP 在 `$DSH_HOME/skill-collections/<集合>/collection.json` 建立稳定集合，Web Skill 管理页按文件夹折叠显示全部成员，并可一键删除整个集合；为保持 DSH 直接子级 Skill 发现兼容，实际 Skill 仍保存在 `$DSH_HOME/skills` 顶层。
- 插件原生依赖兼容增强：Android profile 自动把 `node-pty` override 到与内置 Node 一起构建并通过 require smoke test 的 Runtime 副本，禁止插件再次在手机端 node-gyp 编译；Termux 完整构建若缺少可复用 node-pty 将直接失败，避免产出插件兼容性残缺 APK。
- pnpm workspace 映射写入兼容 `overrides: {}` / `allowBuilds: {}` 空映射，避免重复 YAML key，并把 node-pty 的 allowBuilds 写为真正布尔值 false。
- 根因修复移动端设置裁剪：DSH 设置弹窗位于带 transform/contain/overflow 的侧栏祖先中，导致 position:fixed 仍被侧栏建立的 containing block 裁剪；现打开设置时解除整条宿主祖先链的 transform/filter/contain/overflow 裁剪，关闭后恢复。
- 根因修复插件市场与 Git 插件安装：Web Host 启动前即修复 web profile 的 pnpm workspace 策略，并把 autoInstallPeers=false/nodeLinker=hoisted 传给 Host 子进程；Git 依赖的 ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED 会提取 pnpm 输出中的完整 URL allowBuilds 键，显示授权并可正确写回后重试。
- Skill 导入兼容性增强：允许社区 SKILL.md 缺少完整 frontmatter，按目录名/H1 推导 name、从正文推导 description，并在安装时原子写回标准 frontmatter；单个无法修复条目继续跳过而不终止整包。
- 移动端 Web 设置改为独立的视口级居中弹窗：不再按侧边栏几何布局，分页导航横向滚动，内容区独立滚动，并适配竖屏、横屏与安全区。
- 修复社区插件安装兼容：每次插件操作前自动修复旧 profile 的 pnpm-workspace 配置（nodeLinker=hoisted、autoInstallPeers=false），避免社区插件把 DSH 预发布 peer 误当成需要从 npm 安装的依赖而触发 NO_MATCHING_VERSION。
- 修复 Git/GitHub 插件安装 runtime：构建时递归收集 ELF NEEDED 依赖闭包，解决内置 Git 缺失 libpcre2-8.so 等传递依赖导致 git ls-remote 无法启动。
- Skill ZIP 导入进一步容错：缺少 frontmatter name 时从目录名或一级标题推导并写回；旧式名称自动 kebab-case；单个无法修复条目只跳过，不再让整包失败；缺少 description 时补充安全描述。
- 修复覆盖安装 APK 后插件丢失：运行时升级/修复只替换 `usr/`，若检测到既有用户 HOME，则 snapshot 中的 `home/` bootstrap 数据完全跳过，保留 web profile 的 package.json、pnpm lock、node_modules、插件启用状态、Skill 与凭据。\n- Skill ZIP 导入上限调整：压缩包最大 512 MB、最多 50,000 项、单项最大 512 MB、解压总量最大 2 GB；解决约 63 MB 但包含大量小文件的 Skill 被 4096 项/64 MB 旧限制误拒绝的问题，同时保留 ZIP 路径穿越与解压炸弹防护。\n- Web 设置新增 `Skills` 管理分页：直接管理 `$DSH_HOME/skills`，支持 ZIP/Markdown 导入、列表刷新与安全删除；Skill 变更不修改插件树、聊天记录、模型 Key、settings 或其他 DSH 用户数据。\n- 插件启动保护调整为完全非破坏式：不再自动停用/删除/改写任何插件 bundle；Android 运行时为 permission-presets 注入一个“跟随插件组合默认值”的内部 preset，使插件自定义 sandbox/approval 组合可正常启动，同时保持插件功能与组合语义。\n- README 的“使用的开源项目”清单仅保留 `thness/dsh-mobile` 与 `deepseek-ai/deepseek-harness`。
# V0.1 — Version Reset & GitHub Entry

- Runtime extraction/startup performance pass: 256 KiB streaming buffer, verified-directory cache, batched Android exec-xattr stamping, single-syscall chmod, lower-frequency progress UI updates, fast XZ preset 0 for newly rebuilt snapshots, adaptive 100/250/500 ms engine probing, 80 ms immediate-exit guard, child-liveness early failure detection, and persistent Node compile cache.
- Update the in-app GitHub repository entry and README project link to `keepBacon/dsh-DeepSeek-Harness--Android-Mobile-Enhance`.
- 应用版本重置为 `V0.1`（`versionName=0.1`, `versionCode=35`（保持可覆盖升级既有测试版））。
- “应用设置”新增版本信息和 GitHub 仓库入口。
- 重写 README，补充构建方式、安全说明以及主要开源项目清单。
- 保留既有 Android runtime、插件兼容、ripgrep resolver 与安全解压修复。

# v0.13.4-r1 — Runtime Absolute-Symlink Extraction Hotfix

- 修复首次启动/修复运行时时出现 `snapshot symlink uses absolute target: usr/bin/bash -> /system/bin/sh`，导致解压中断并连带报告 `usr/bin/node`、DSH CLI、`libtermux-exec-ld-preload.so` 缺失。
- 保留 v0.12.9 的路径穿越防护：仍拒绝任意绝对路径和任意其他绝对 symlink；仅精确允许上游 Android runtime 使用的只读系统 shell `/system/bin/sh`。
- symlink 父目录保护保持不变，因此归档仍不能借助该链接把后续文件写到 runtime 根目录之外。
- `修复运行时` 会先清理不完整的 `usr/`，新构建安装后可直接重新解压，不需要手动清数据。

# v0.13.4 — Android ripgrep Resolver Fix

- 修复 v0.13.3 仍无法处理 `0.1.5-rc.2` 实际发布形态：`let rgPath = (await import("@vscode/ripgrep")).rgPath`。
- 新增 `@vscode/ripgrep` resolver 级兼容，优先使用 `DSH_RG_PATH`，避免 Android 尝试解析不存在的 `@vscode/ripgrep-android-arm64`。
- fs-search 直接补丁现在兼容 direct-return 与 intermediate-variable 两种 bundle 形态。
- 新增构建期 resolver smoke test：嵌入式 Node 必须实际 import resolver，并解析到 APK 内 `usr/bin/rg`。
- 静态回归不再只测试正则，而是创建发布布局 fixture，实际执行 Android patcher 并验证产物。

# v0.13.3 — fs-search Published Layout Compatibility Fix

- 修复 `@deepseek-ai/dsh-tool-fs-search` Android ripgrep patch 对 `lib/index.js` + 双引号单一输出形态的错误假设。
- 兼容官方 0.1.5-rc.2 的拆分 `lib/search-core.js` / 打包 `lib/index.js` 两种发布布局。
- 同时兼容单引号、双引号和 `.js/.mjs/.cjs` 输出。
- 仍保持 fail-closed：找不到实际 `@vscode/ripgrep` 动态导入时停止构建，而不是生成缺少搜索功能的 APK。
- 保留 v0.13.2 Koffi Android prebuilt 检测及 v0.13.1 全量审计修复。

# v0.13.3 — Koffi Android Prebuild Detection Fix

- Fixed a false build failure introduced by the v0.13.1 native-addon audit. Koffi 3.2.1+ can load its native addon from the sibling optional package `@koromix/koffi-android-arm64`, so requiring `koffi/*.node` to exist inside the main `koffi` directory was incorrect.
- The build now validates Koffi by loading it with the exact embedded Node and staged Android `LD_LIBRARY_PATH`, then confirms that a Koffi `.node` entry was actually loaded into `require.cache`.
- If the Android prebuilt is already loadable, source compilation is skipped. If it is not loadable, the existing API-30 source build remains as a fallback and is verified again after compilation.
- Keeps the fail-closed guarantee: a Koffi package that cannot actually load its native addon still stops the APK build.

# v0.13.1 — Full Audit Remaining Bug Fixes

- Fix workspace-import check/rename races with no-overwrite publication and shared-storage fallback reservation.
- Bound local plugin package input size plus ZIP entry count, path depth, per-entry bytes and total expanded bytes.
- Distinguish DSH bundles from plain profile dependencies; plain dependencies can no longer be toggled as bundle layers.
- Remove mobile UI full-body text scans and periodic sync polling; filter MutationObserver work to relevant shell/settings/composer mutations.
- Complete primary/removable storage-root resolution and Android 8–10 legacy workspace/download compatibility.
- Add queued same-origin downloads and queued notification replay after runtime notification permission is granted.
- Add transactional multi-format SSH-key import, encrypted SSH passphrase storage, and encrypted host-scoped Git HTTPS credentials.
- Harden Git askpass host matching to parse and compare the exact HTTPS host, rejecting suffix/prefix lookalikes.
- Keep desktop-parity builds on stable DSH unless alpha is explicitly requested.
- Remove the remaining Node-header `cp -a` hard-link hazard and correct the stale x86_64 snapshot diagnostic to arm64.
- Correct Shizuku capability wording and reuse the upstream DSH Settings icon for the Android app-settings trigger.
- Add `check-remaining-fixes.sh`, including XML, injected-JS and Git-askpass regression checks.

# v0.13.0 — High Reliability & Runtime Transaction Fixes

- All privileged WebView bridge callbacks that touch Android UI now marshal to the main thread.
- Engine shutdown is synchronous: graceful stop, bounded wait, forcible fallback, final exit confirmation.
- Added a cross-instance maintenance guard so EngineService cannot relaunch DSH during plugin/profile mutation, runtime repair, or OTA replacement.
- Reworked DSH public-data migration as a transactional copy/backup/symlink/rollback flow; migration markers are committed only after every destructive step succeeds.
- OTA runtime identity now distinguishes bundled and signed OTA runtimes. A valid OTA is no longer overwritten on the next launch simply because its marker differs from the APK bundle marker.
- OTA replacement now stops the live engine before swapping files, smoke-tests Node + DSH in the final path, and keeps usr-old until validation succeeds. Directory and marker rollback are handled as one logical transaction.
- Android runtime patches for 0.1.5-rc.2 storage/flock paths are fail-closed across all discovered package instances.
- Native addon build checks no longer treat a successful npm command as proof that koffi/node-pty is usable; every built instance must produce a .node file and pass a Node require() smoke test unless degraded mode is explicitly enabled.
- Snapshot rebuilds preserve every top-level tree from the base archive, including home/, instead of repacking usr/ only.

# v0.12.9 — Severe Security & Runtime Integrity Fixes

- Snapshot extraction now rejects path traversal, absolute paths, escaping symlinks, parent-symlink traversal and preserves only verified in-tree hard links.
- EngineProbe no longer treats arbitrary HTTP services on port 3080 as DSH; it verifies the DSH authentication challenge / DSH HTML signature.
- Android JavascriptInterface privileged calls now require a per-Activity unguessable capability injected only into the main-frame shell shim.
- Global cleartext traffic disabled; only localhost/127.0.0.1 is allowed for the embedded DSH HTTP origin.
- Online runtime update is fail-closed: HTTPS + exact size + mandatory SHA-256 + Ed25519 signed manifest + 1 GiB cap; insecure emulator HTTP default removed.
- Runtime update swap now restores the old runtime/version marker if activation fails.

# DeepSeek Harness Mobile - 开发日志

## v0.12.8 (2026-09-19)

### Startup / auth reliability
- Stop preloading localhost before the embedded Host is ready; ordinary launches no longer land on the recovery-button screen first.
- Keep recovery actions hidden until an actual runtime/Host failure is confirmed.
- Always prefer the current Host launch-token URL when attaching a newly-created WebView, and let WebView own the 303/Set-Cookie redirect.
- Recover main-frame 401/403 responses by reloading the current launch-token URL instead of leaving `ERR_HTTP_RESPONSE_CODE_FAILURE` visible.
- Flush authenticated WebView cookies after local DSH pages finish loading.

### App UI settings
- Add a Lucide Settings icon to the Android top navigation bar.
- Add persistent `移动端` / `原生（DSH 原布局）` interface modes under 应用设置 → 界面设置.
- Native mode keeps the Android app bar for mode switching while forwarding menu/new-session actions to the upstream DSH shell.

## v0.12.7 (2026-09-19)

### Plugin compatibility
- Backport pnpm 11 build approval handling from the newer DSH plugin-manager model.
- Detect pending `allowBuilds` entries and require explicit user approval before running third-party install scripts.
- Classify plugin failures and retry transient network failures only.
- Validate the composed web profile after install/update/enable; automatically disable incompatible new bundles to keep the Host bootable.
- Bundle npm/npx alongside pnpm for community lifecycle scripts.
- Expand GitHub URL/shorthand normalization and plugin metadata diagnostics.
- Roll back profile package/lock manifests on failed or build-blocked installs while preserving pnpm build-approval state.
- Pin lifecycle scripts to the embedded Bash/system shell and keep npm/npx available inside the APK runtime.
- Improve local ZIP imports for monorepos by preferring packages that declare `dsh.bundle`, and restore executable bits for package `bin` entries.

## v0.12.6 (2026-09-19)

### 修复
- 移动端侧边栏改为显式关闭：侧栏内部操作不再自动收起，仅菜单按钮、遮罩或 Android 返回键关闭。
- 修复退出 Activity 后再次进入时可能长期停在启动页：已运行 Host 复用干净的 127.0.0.1:3080，会话 token 只在新 Host 冷启动时消费。
- 修复引擎子进程已退出但 90 秒 cooldown 仍阻止重启的问题；仅复用真正 isAlive 的进程。
- 修复 pnpm 全局 symlink 被 Android wrapper 重定向覆盖，导致 pnpm.mjs 变成 shell 脚本并报 SyntaxError: Unexpected string。
- pnpm entrypoint 兼容 .cjs / .mjs / .js。

# v0.12.5 (2026-09-19)

- 修复 EngineManager.kt 中 DSH token URL 正则使用普通 Kotlin 字符串导致的 `Unsupported escape sequence` 编译失败。
- 改用 Kotlin raw string，并同时识别 `127.0.0.1`、`localhost` 和 `[::1]` 回环地址。
- 保留 v0.12.4 的 `--no-open`、token URL 启动、Git/SSH/CA 和 Android compatibility runtime。

# Changelog

## v0.12.4

- Add `--no-open` to embedded `dsh web` startup so Android never attempts a desktop browser launch.
- Treat any valid local HTTP response below 500 as Host liveness; auth redirects/401/403 are no longer reported as startup timeout.
- Parse the token-bearing startup URL from `engine.log` and load it into the Android WebView to complete the DSH 0.1.5-rc.2 session bootstrap.
- Prevent the foreground-service watchdog from repeatedly restarting an already-listening authenticated Host.

# DeepSeek Harness Mobile - 开发日志

## v0.12.3

- 修复 `cp -aL` 复制 Git helper 时因保留 hard-link 关系导致 Android/Termux `Permission denied`。
- `git-core` 和模板目录改为不保留硬链接的独立文件复制。
- 保持 DSH 稳定渠道 `0.1.5-rc.2`、Git/SSH/CA、插件安装和移动端 UI 兼容层不变。

# Changelog

## v0.12.2

### Git / GitHub / SSH plugin compatibility
- Bundle the Termux Android Git executable and its complete `git-core` helper set into the standalone APK runtime.
- Bundle OpenSSH client tools and required linked libraries for `git@github.com` / `ssh://` plugin specs.
- Bundle a CA certificate chain and export Git/curl/Node certificate environment variables.
- Override Git's compile-time Termux paths with runtime `GIT_EXEC_PATH`, `GIT_TEMPLATE_DIR`, and `GIT_CONFIG_SYSTEM`.
- Disable invisible interactive Git credential prompts and use SSH `StrictHostKeyChecking=accept-new` with app-private known_hosts.
- Add Android-side SSH private-key import with app-private storage and 0600 permissions.
- Normalize copy-pasted GitHub repository and branch web URLs into installable git package specs.
- Make local ZIP plugin import safe and functional by extracting into app-private storage, blocking path traversal, enforcing a 512 MB expanded-size cap, and installing the shallowest directory containing `package.json`.
- Fail the refreshed runtime build if Git, `git-remote-https`, SSH, or the CA bundle is missing instead of shipping a partially compatible APK.
- Keep stable-channel DSH `0.1.5-rc.2` as the default runtime.

## v0.12.1

- Make npm stable-channel `@deepseek-ai/dsh 0.1.5-rc.2` the default embedded Harness.
- Keep `0.1.6-alpha.2` as an explicit opt-in through `build-latest-termux.sh`.
- Make the `node-addon-require-builtin` boot patch/version check conditional so the stable-channel graph is not rejected for a 0.1.6-only requirement.
- Preserve Android native module, shared-storage, Sharp WASM, ripgrep, plugin/settings and mobile UI compatibility work from v0.12.0.

## v0.12.0

### Latest DSH + Android compatibility runtime
- Update the embedded Harness target to `@deepseek-ai/dsh 0.1.6-alpha.2`.
- Make latest-runtime refresh the default build path; keep stable (`0.1.5-rc.2`) and offline fallback scripts.
- Sync the Termux Node LTS executable and its linked runtime libraries into the APK before installing the new DSH graph.
- Build `node-pty` and `koffi` explicitly for Android instead of silently packaging missing native addons.
- Add the mandatory `node-addon-require-builtin` JavaScript fallback used by DSH 0.1.6-alpha.2 host preparation on Android, while retaining `--expose-internals`.
- Add single-process Android flock fallback for `@deepseek-ai/node-addon-system`.
- Install Sharp WASM fallback and wire an embedded Termux ripgrep through `DSH_RG_PATH`.
- Add guarded Android hard-link fallbacks for session persistence, filesystem publication, and attachment storage.
- Restore legacy dsh-settings helpers when the upstream export shape matches, improving compatibility with older community plugins.
- Add DSH-version-aware runtime diagnostics and Android-specific recovery hints.
- Preserve all v0.11.4 mobile layout, composer import, settings, plugin manager, workspace import, and local-engine features.

## v0.11.4

### Composer file import + Settings mobile fix
- Move the Android workspace-file import affordance out of the top bar / workspace picker and place it directly beside the conversation composer controls.
- Keep the importer available on both the empty hero composer and active sessions; the selected phone files are still copied into the current/recent Workspace, not attached as transient chat blobs.
- Fix Settings mobile DOM detection: identify the real `<nav>`, content column, header, and scrollable options region instead of treating the nav-list container as the whole Settings shell.
- Rebuild Settings as a full-height mobile panel below the app bar with horizontally scrollable section tabs and an independently scrolling content region.
- Prevent Settings content from being squeezed by the desktop 188px navigation rail, and constrain media/forms to the phone viewport.
- Keep Android Back / Escape, plugin manager, config editor, workspace import, local engine, and v0.11.3 drawer/sheet behavior unchanged.

## v0.11.3

### Mobile UI redesign
- Replace fixed 1280px desktop viewport with real device-width viewport.
- Switch WebView UA to Android mobile while retaining the embedded local DSH Host.
- Add a compact mobile top bar with sidebar, new-session, and workspace-import actions.
- Convert the desktop sidebar into an off-canvas drawer with scrim and auto-close navigation.
- Force the AppFrame center column to use full device width; hide desktop resize handles.
- Present the right detail column as a mobile bottom sheet.
- Add conversation/composer mobile gutters and safe-area spacing.
- Reflow workspace picker + phone-file import actions on narrow screens.
- Detect Settings modal and convert its vertical navigation into horizontal mobile tabs.
- Constrain dialogs, menus, and listboxes to the visual viewport.
- Preserve plugin manager, configuration editor, file import/share, runtime recovery, and local engine behavior from v0.11.2.
