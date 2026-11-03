# Lua/Luau VM 分析工作流

内置 mobile_tools 提供 `lua_analysis_capabilities`、`lua_vm_analyze`、`lua_vm_instrument`、`lua_dynamic_run`、`lua_trace_analyze`、`lua_vm_lift`、`lua_trace_compare`、`lua_analysis_workflow`，以及持久案件工具 `lua_case_create/run/status/compare`。

动态后端为固定版本 luau-web 1.5.1 的真实 Luau WASM。支持数字/二分分发候选、手动表分发探针、PC/opcode/寄存器快照、观察 CFG、操作数 IR、候选反向切片和差分分析。未知 handler、未访问路径和不支持的 API 保留未知，不能据此宣称完整还原商业 VM。

## 宿主开发

在 checkout 外安装 `luau-web@1.5.1`，导出 `DSH_LUAU_WEB_PATH` 指向该包的 `src/index.js`。运行 `node --test scripts/test-lua-workflow.mjs`。

工具支持 MCP 参数，也支持 CLI：

```sh
node scripts/dsh-lua-tools.mjs lua_case_create create.json
node scripts/dsh-lua-tools.mjs lua_case_run run.json
node scripts/dsh-lua-tools.mjs lua_case_status status.json
node scripts/dsh-lua-tools.mjs lua_case_compare compare.json
```

建案参数示例（`caseDir` 必须为新目录）：

```json
{"caseDir":"/tmp/lua-case-001","source":"print(analysis_input); return analysis_input","scenarios":[{"name":"baseline","globals":{"analysis_input":7}},{"name":"variant","globals":{"analysis_input":9}}]}
```

运行参数：`{"caseDir":"/tmp/lua-case-001","maxTasks":1,"wallTimeMs":30000}`。再次运行继续队列，不重跑已完成任务；CLI 返回码 2 表示仍有待办/阻塞，不代表检查点丢失。

状态参数：`{"caseDir":"/tmp/lua-case-001","verifyEvidence":true}`。对照参数：`{"caseDir":"/tmp/lua-case-001","baselineScenario":"baseline","candidateScenario":"variant"}`。

## 检查点与输入

案件保存源码、静态分析、动态执行、未插桩基线和结果证据。中断后只复用源码、输入和引擎代码指纹匹配的已完成阶段。案件不是持久 Luau VM，不恢复调用栈、闭包、协程或跨 loadstring 返回值。

`fixtures.http` 提供 URL 到本地响应文本的映射，`fixtures.services` 提供服务数据，`globals` 提供显式全局输入。运行不会自动访问远程加载器。`loadstring` 参数按字节捕获，当前阶段返回记录调用的空函数；被调用的文本捕获层可作为独立子任务运行。

缺失夹具会产生 `supply-http-fixture` 等结构化需求。通过 `taskOverrides:[{"taskId":"t000001","options":{"fixtures":{"http":{"https://example.test/loader":"return 42"}}}}]` 补齐后继续。夹具、全局输入和随机种子随捕获子层继承；探针位置不跨不同源码自动继承。阻塞任务不会隐式反复重试，恢复外部条件后用 `retryTaskIds` 显式重试；已完成任务改配置也需要显式重试。

默认比较插桩与未插桩的观察结果/API 事件，行为不同会阻止自动跟进探针捕获层。可以审阅角色提示与 `probeOffset`，或重试 `instrument:false`。手动偏移按原始字符串 UTF-16 code unit 计数，必须位于 token 起点。

最多 8 个输入场景、64 个任务、每任务 8 次尝试、层深度上限 6；达到当前深度限制的捕获层保留待办。证据采用哈希复核与私有权限，目录需要支持原子重命名/硬链接。并发运行会返回 busy；正常死进程锁可以恢复，恢复锁本身中断时需核查归属。

对照只匹配源码 SHA-256 与深度相同的任务，重复候选报告歧义，缺失或不同源码报告未匹配。空轨迹不作为 VM 等价证据；观察覆盖并集不是全程序覆盖证明。

## Android 与构建

Termux 和 GitHub 构建会打包四个分析模块与固定 Luau 后端。Android 端需要新运行时快照。运行器使用一次性 WASM 进程、墙钟超时与事件限额，不暴露 Node、真实网络和文件 API；V8 堆限额不等于完整 OS/WASM 内存配额，也不模拟真实 Roblox 引擎。

GitHub ARM64 工作流默认只构建/上传产物。创建 Release 需要显式 workflow_dispatch 且开启 `publish_release`，默认关闭。
