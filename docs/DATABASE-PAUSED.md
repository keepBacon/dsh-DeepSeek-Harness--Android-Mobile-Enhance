# 数据库增强 V1 — 已恢复开发（2026-10-23）

状态：**已恢复至 main 的候选实现；尚未完成 Android APK / 实机验收。**

- 原暂停草稿 PR：[#28](https://github.com/keepBacon/dsh-DeepSeek-Harness--Android-Mobile-Enhance/pull/28)，基于旧分支，不可直接合并。
- 恢复提交：[`4ef420a`](https://github.com/keepBacon/dsh-DeepSeek-Harness--Android-Mobile-Enhance/commit/4ef420a69d376f8aa07b68920dfb72584049c8c5)，以当前 main 宿主代码重新集成。
- 数据库：Android 应用私有 SQLite，WAL 与外键；索引仅为可重建的元数据。
- 范围：工具注册快照、工具调用状态与错误分类、会话文件元数据、插件/Skill/MCP 配置索引、应用内完整性检查与一致性备份。
- 保留原始权属：DSH 原生会话、插件、Skills、MCP 配置仍是唯一事实来源；数据库不是其替代品。
- 性能：快照相同时跳过批量插入；异步单线程工具观测写入；工具状态不变时不重复提交。
- 完整性：不完整的会话目录扫描不会清理旧索引；备份采用 `VACUUM INTO` 并校验导出的 SQLite 文件。
- 尚待：目标 Android SQLite 版本对 `VACUUM INTO` 的支持、WAL/数据库备份真机测试、应用重启后的索引重建、长时间压力测试、真实 WebView 桥事件和数据目录迁移验证。
- 发布状态：静态测试与本地模拟不能取代真机集成验收；正式发布前必须构建 APK 并检查数据库功能。

## 测试入口

```bash
node scripts/test-mobile-database-contract.mjs
cd ~/DSH-Mobile && git pull --ff-only origin main && bash build-termux.sh
```
