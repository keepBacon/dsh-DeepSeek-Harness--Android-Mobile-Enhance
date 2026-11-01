# DSH 核心升级工作记录 — 0.2.1-rc.5

## 实际检查结果

- 上游 tag：`dsh-v0.2.1-rc.5`，commit `b830ec950faba0a46dda564be3e2d854afed94f1`，2026-10-30 发布。
- 现有 Android 运行时：`0.1.5-rc.2`；本分支目标：`0.2.1-rc.5`。
- 上游 Node 要求：`^22.19.0 || >=24.0.0`；pnpm `11.28.5`。
- 迁移中的 Cordis 和 vendor 必须整套替换，不能把旧版 SDK/Loader 与新版 DSH 混装。
- 用户 HOME、profiles、sessions、数据库和工作区不得被新运行时重建或覆盖；签名必须复用已验证旧 keystore；只使用 GitHub Actions 构建。

## 已定位的 CI 阻塞

最新静态预检在 `Validate Android patches against published DSH 0.2.1-rc.5` 中失败：

```
Error: sandbox-local confine anchor changed (0)
.../@deepseek-ai/dsh-sandbox-local/lib/index.js
```

说明上游 sandbox-local 已改变实现。必须按新源码重写 Android 兼容接缝，而不是删掉检查或者跳过补丁。

## 实际升级尚需完成的工程步骤

1. 从 `0.2.1-rc.5` 已发布 npm 包构造完整、可重复解析的依赖图。包含新命名空间包，并验证全体 DSH 组件同版本，Vendor 精确匹配，Cordis 单实例。
2. 适配 Android sandbox-local / subprocess-local / terminal-bash / session 持久化 / code runtime / MCP 与插件管理的新上游布局；移除只适用于旧版的注入。
3. 调整 `ci-assemble-github-runtime.py`：它目前只复制旧 APK 的 DSH/Node 种子并覆盖宿主脚本，**不会实际安装新版 DSH**。需要经受 Android ARM64 ABI 检查的升级路径，不得将 Linux native addon 写进 Android 归档。
4. 验收构建后的 `snapshot.tar.xz` 中实际 `@deepseek-ai/dsh/package.json` 为 `0.2.1-rc.5`，并检查内置 Web UI 资源、配置兼容、MCP 工具注册与新旧 profile 数据目录不被触碰。
5. GitHub Actions 预检与正式 ARM64 构建成功、APK 签名和覆盖版本号检查成功后，才允许合并主分支。

## 放行规则

本分支是升级候选；**不要合并**，直至满足上述步骤。只修改 release lock / README 的版本号不等于升级已完成。任何旧版运行时仍被装进 APK 的场景应当构建失败。
