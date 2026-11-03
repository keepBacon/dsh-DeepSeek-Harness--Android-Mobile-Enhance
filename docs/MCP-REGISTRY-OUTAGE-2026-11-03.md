# MCP 注册表丢失事故修复记录（2026-11-03）

## 设备报告观察（第三轮）
- host 保持运行且 DSH GUI 响应 401，但 run_code worker 可见注册表仅 41 个核心函数。
- basic(52)、mobile(104)、nhance(188) 共 344 个 MCP 工具不在工具注册表中；在新 worker 和子代理中复现。
- bili 代理在同一时间返回 proxy is down；read_page/x_search 另有旧的 profile 路径故障。
- 这不能由 worker 内的等待解决，因为 worker 的工具绑定从 Host 的当前工具发布状态生成。

## 已确认的代码机制
上游 DSH 0.1.5-rc.2 的 `@deepseek-ai/dsh-mcp-client` 内置重连监督器默认
`maxAttempts=10`，超过限额就注销当前服务器的工具，直到该插件被重新加载或 Host 重启。
`McpConfigManager.kt` 旧版未设置 reconnect 参数，因此沿用这个上限。
这与 Android 后台切换、MCP 子进程失活后整批工具消失的现象吻合，
但目前**缺少出事时完整 engine.log**，不可认定这是全部故障的唯一原因。

## 修复
三类 MCP 配置（mobile/basic/自定义）统一显式写入官方 mcp-client 支持的选项：

```yaml
reconnect:
  enabled: true
  initialDelayMs: 1000
  maxDelayMs: 30000
  maxAttempts: 1000000
```

仍使用上游同一个带指数退避的监督器，未引入 Android 侧额外轮询线程；
保留 `failOnStartupError: false` 和原有单服务器失败隔离策略。
即使长期后台中断也不会在前 10 次重连失败后进入永久注销状态。
`maxAttempts` 是大但有限的恢复预算，**不是永不失败的保证**；
上游若检测到无法关闭旧进程，为避免重叠仍可能主动停止重连。

## 不在本次改动中
- 不能从 GitHub 操控用户手机上的现有 DSH Host，因此旧进程里的失效连接
  不会仅因 GitHub 源码提交而自愈；必须安装新构建，旧实例可通过重启恢复。
- bili 代理不是这三个 MCP 客户端；其进程管理、重连恢复需要独立日志/源码定位。
- `read_page`/`x_search` 的 profile 缺失需要针对其插件原始路径另修。
- 本次没有清理 `~/.dsh`、配置、会话、nhance 数据或用户授权/密钥。

## 复验
1. CI：`node scripts/test-mcp-reconnect-contract.mjs`；Gradle 和运行时图预检。
2. 安装可覆盖的签名一致 APK，确认旧会话与 profile 完整。
3. Host 内原地检查工具清单，核对 basic/mobile/nhance 实际名称，而非仅工具总数。
4. 后台保持超过旧重试窗口、恢复前台，检查 `mcp-client(...): reconnected and re-synced tools`
   以及新 run_code worker 是否重新拥有 MCP 工具。
5. 重新运行用户预备的 151 条测试用例（`dsh_tool_test/retest/r3_cases.json`），
   对比第三轮报告。**测试文件目前没有出现在本仓库**，不能声称已续跑。

## 验收标准
- 无需重启 Host 即可在后台短时 MCP 子进程中断后再次发布真实工具定义。
- 没有两个相同命名空间或旧进程并存；未知服务器仍独立报错。
- 主机断线恢复不修改任何用户 profile、密钥或会话。
- Core/bili 代理异常与 MCP 注册表异常分别报告，禁止混为一条成功结论。
