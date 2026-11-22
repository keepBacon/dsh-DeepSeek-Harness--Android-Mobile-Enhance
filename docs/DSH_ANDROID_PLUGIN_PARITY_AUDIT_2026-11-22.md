# DSH Android 插件运行时兼容差异审计（阶段 1）

基准：Android 仓库 `main@3ba5c4b5`；官方 `deepseek-ai/deepseek-harness@9c2670d3bce5275e0d1610272958121af87787bb`，发布版本 `0.2.2-rc.5`。

此文档只记录已经从上述源码确认的调用链及仍需验证的行为。**源代码存在、npm 构建通过、Host 已启动、Web 插件页面已出现、模型成功执行 MCP 调用**属于五项不同的验收，不可相互替代。

## 核心架构结论

1. 官方 Cordis 是依赖注入及生命周期的唯一权威。服务访问 `Context.get/provide` 由 `vendor/cordis/src/reflect.ts` 负责；插件依赖及 `ctx.inject()` 是 `vendor/cordis/src/registry.ts`；Fiber 卸载和资源清理由 Cordis 实现。Android 不应新增独立服务容器。
2. 插件安装、更新、patch 合成来自 `packages/boot/plugin-manager/src/index.ts`、`packages/boot/plugin-manager/src/patch.ts` 和官方 App Boot。Android 封装执行环境和签名构建，而不是重写 profile 文件格式或绕过版本检查。
3. Web 前端入口由 `packages/client/modules/src/client/index.ts` 的 `ClientModuleSystem`、`entries.ts` 的 loader/版本协调、`entry-lifecycle.ts` 的卸载回收负责。一个插件 Host 运行成功不等于它的 `./client` 已加入浏览器清单。
4. 0.2.2 插件可通过 **`plugins.item`、`plugins.bundle.config`、`plugins.row.config`、`plugins.tab`** 注册插件页面；Settings 由 `settings.section` 和 `settings.plugins.tab` 等插槽支持。官方 `packages/client/ui-plugin-manager/src/client/index.ts` 和 `config-ledger.ts` 读取可观察的插槽注册表；不能硬编码插件页。
5. Remote 由 `packages/api/remotes/src/client/index.ts` 聚合 Host RPC face，包括 pluginManager、mcpManager、pluginInventory。第三方服务还依赖正常的客户端模块注册、Remote 接入与 Cordis 生命周期。
6. 官方 `packages/mcp/mcp-client/src/index.ts` 基于 Cordis 插件与 `ctx.tools`，`transport.ts` 支持 **stdio、Streamable HTTP**；`connection.ts`/`generation.ts` 管理重连、超时、取消、工具增删；不要宣称官方这一版本支持未声明的第三种传输。
7. Android 环境通过 `EngineManager.kt` 装载官方 Web Profile、Node/Termux 和 `McpConfigManager.kt` 生成附加 MCP patch；`MainActivity.kt` 的 WebView 桥只能适配设备/布局，不应成为插件 UI 注册或服务注册器。

## 功能差异矩阵

| 系统/能力 | 官方 0.2.2 源码 | Android 仓库已见实现 | 当前判定 | 仍需完成的验证 |
|---|---|---|---|---|
| Cordis 服务提供、`ctx.get()`、`ctx.inject()`、Fiber 生命周期 | `vendor/cordis/src/{reflect,registry,fiber}.ts` | 0.2.2 release-family 包含 Cordis，不另造容器 | **部分实现（打包可检查；运行未验收）** | 真机插件注册/依赖变更/卸载后无遗留 |
| 插件安装、更新、禁用、恢复 | `packages/boot/plugin-manager/src/{index,operations,patch}.ts` | 官方管理页与安装命令、Android Node/Git/pnpm 兼容层 | **部分实现** | npm/Git/本地包含失败回滚；数据完整性 |
| 第三方 `./client` 加载与 HMR | `packages/client/modules/src/client/{system,entries,entry-lifecycle}.ts` | 官方 Web + mobile WebView | **部分实现** | Host 清单/浏览器注册/热替换/关闭组件 |
| Plugins 页面插槽配置 | `packages/client/ui-plugin-manager/src/client/{index,config-ledger,tab-ledger}.ts` | 复用官方 Plugins 页面；Android 设置入口只负责导航 | **部分实现** | 动态配置页、保存、刷新、卸载后消失 |
| Settings 的 `settings.section`、`settings.plugins.tab` | `packages/client/ui-settings-general/src/client/SettingsRoot.tsx`、`ui-settings-plugins` | Android 自定义设置弹窗 CSS 和 DOM 标记 | **已发现实现错误，阶段补丁已修复** | 真机第三方弹窗与官方设置交替打开 |
| `ctx.remote`、RPC、Credentials | `packages/api/remotes/src/client/index.ts`、`packages/credentials/*` | 官方 Host/Web；Android 另有系统凭据存储和桥接 | **部分实现（端到端未验证）** | 凭据读取/更新/删除、断线恢复、无明文泄漏 |
| MCP stdio / Streamable HTTP | `packages/mcp/mcp-client/src/{index,transport,connection,generation}.ts` | Android MCP patch、执行桥、HTTP URL | **部分实现** | 真实握手、tools/list、callTool、SSE、取消与断线 |
| MCP resources / prompts | 官方 MCP 客户端与 API/注册路径 | Android 沿用 MCP 插件 | **待验证（不能标完全实现）** | 真实 server resources/list、prompts/list、读取结果 |
| 工具发现及模型调用 | `mcp-client` → `ctx.tools` → Agent 工具集 | 内置 MCP + 第三方配置 | **部分实现** | PTC 和普通模型路径都能调用并回传结果 |
| Node Worker、ESM、CommonJS、原生 ABI | 官方 Node/ptc 运行时 | Android 依赖 ARM64 Node、linker 桥及运行时补丁 | **部分实现** | 真机 worker、动态 import、require、重启与释放 |
| Windows COM、桌面窗口 API、x86 DLL / 特有硬件 | 依赖对应桌面 OS 的插件自行调用 | Android 无相同内核和设备 | **平台天然不支持** | 明确拒绝/等效实现；禁止虚报支持 |

**关于“完全实现”**：本轮没有把任何未经 Android app-UID 真实执行测试的功能标为“完全实现”。

## 已修复的通用兼容问题

**问题：Android 错误捕获插件自有弹窗。** 之前 `MainActivity.kt` 的 `findSettingsParts()` 遍历任意 `[role=dialog][aria-modal=true]`，只要内部有“Models/Plugins”等导航文字就当作官方 SettingsRoot。第三方插件拥有自己的 Modal 时，Android 会附加布局属性、原生 Skill 标签与 CSS，影响动态 UI。

**修复：** 精确限定 `[data-shortcut-modal="settings"][role="dialog"][aria-modal="true"]`。这是官方 `SettingsRoot.tsx` 自身输出的结构化标识，不依赖翻译文字或插件名称。新增 `scripts/test-android-plugin-ui-isolation.mjs`，用真正的提取函数验证官方 SettingsRoot 能识别，而同词标签的第三方弹窗不会被识别。

**新增 CI 运行时完整性检查：** `scripts/validate-android-plugin-runtime-parity.mjs` 在实际构建的 `node_modules` 中验证 Cordis/Host/Client Modules/Slots/Plugin Manager/Remote/MCP/PTC 包的存在、统一的 0.2.2-rc.5 版本及可解析的 JS 入口。它是包完整性检查，**不是插件运行成功的证明**。

## 后续必须进行的端到端测试

1. **Client UI 先行**：构造纯 JS 的三方插件测试包（Host + `./client`），同时注册 `settings.section` 和 `plugins.bundle.config`，记录创建、状态更新、卸载、恢复、重载次数；用真实浏览器（Android WebView）验证。
2. **Cordis/Remote**：独立测试 `ctx.provide/get/inject` 的依赖切换、跨插件服务可见性、Remote 请求/响应和客户端注销。勿用模拟成功的工具输出代替真实服务回包。
3. **MCP**：两个真实独立 server 并行测试 stdio、Streamable HTTP、资源和提示词、Schema、tools/list、callTool、超时、取消和重连，再让标准 Agent 与 PTC Agent 分别实际调用。
4. **插件安装**：npm 包、Git 源码、需 `prepare` 的包、失败构建、损坏 manifest、旧 peer 依赖、离线恢复及可撤销更新；校验用户 profile/node_modules/credentials/session 文件散列与修改范围。
5. **设备/架构**：ARM64 Android 真实 app UID 验证，包括 loader/noexec、Worker、WebView CSP、证书链、后台 Host、屏幕方向切换和覆盖安装保留数据。

## 架构约束

- 官方 Cordis、Module System、Remote、Plugin Manager、MCP Client 继续作为唯一业务实现；Android 只负责执行时的 OS 边界适配。
- 失败必须可观察（包、生命周期、Host 连接、客户端注册、Remote 授权、MCP 握手、工具结果分层诊断），不静默吞掉、不伪造成功。
- 不修改、清空用户插件、凭据、工作区和会话来“恢复”兼容。
- 没有设备端可重复验收前，不宣称完成“所有插件兼容”，也不得把不支持 Windows/Linux 专属能力的插件列入完全兼容。

官方源码基准：https://github.com/deepseek-ai/deepseek-harness/tree/9c2670d3bce5275e0d1610272958121af87787bb

Android 仓库：https://github.com/keepBacon/dsh-DeepSeek-Harness--Android-Mobile-Enhance
