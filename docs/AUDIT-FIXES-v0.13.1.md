# v0.13.1 全量 Bug 审计修复状态

基线：DeepSeek Harness `0.1.5-rc.2`，Android API 26+，arm64。

| ID | 等级 | 状态 | v0.13.1 结果 |
|---|---|---|---|
| C-01 | 严重 | 已修复 | snapshot 解压 path/symlink/hard-link 边界校验 |
| C-02 | 严重 | 已修复 | OTA HTTPS + size + SHA-256 + Ed25519 fail-closed |
| C-03 | 严重 | 已修复 | EngineProbe 验证 DSH 身份，不把任意 3080 HTTP 服务当 Host |
| C-04 | 严重 | 已修复 | WebView bridge capability + DSH 主文档 origin 限制 |
| H-01 | 高 | 已修复 | Android UI bridge 统一切回主线程 |
| H-02 | 高 | 已修复 | Engine stop 等待 + force-stop + 最终退出确认 |
| H-03 | 高 | 已修复 | Maintenance Lock 阻止 watchdog 与插件/更新事务竞争 |
| H-04 | 高 | 已修复 | 用户数据迁移 copy/backup/symlink/rollback 事务 |
| H-05 | 高 | 已修复 | bundled / OTA runtime marker 分离 |
| H-06 | 高 | 已修复 | OTA runtime swap + smoke-test + rollback |
| H-07 | 高 | 已修复 | 更新前由 EngineManager 正常停止 Host |
| H-08 | 高 | 已修复 | Android 必需 runtime patch fail-closed |
| H-09 | 高 | 已修复 | node-pty/koffi `.node` + require() smoke-test |
| H-10 | 高 | 已修复 | snapshot 重打保留全部顶层目录（含 home/） |
| M-01 | 中 | 已修复 | 工作区导入 no-overwrite 发布，消除 check/rename 覆盖竞态 |
| M-02 | 中 | 已修复 | 本地插件压缩包 512 MB 输入上限 |
| M-03 | 中 | 已修复 | ZIP entry/深度/单文件/总解压大小限制 |
| M-04 | 中 | 已修复 | Bundle 与普通 dependency 分类，普通依赖不可启用 |
| M-05 | 中 | 已修复 | 移除 1.6 s DOM 轮询 |
| M-06 | 中 | 已修复 | 移除 body.innerText/全页扫描；过滤无关 Mutation |
| M-07 | 中 | 已修复 | primary 与可识别 removable storage 根目录解析 |
| M-08 | 中 | 已修复 | Android 8–10 legacy 权限、兼容工作区、旧系统 Downloads |
| M-09 | 中 | 已修复 | 多格式 SSH key + 可选 passphrase + Android Keystore |
| M-10 | 中 | 已修复 | 私有 Git HTTPS token + host-scoped askpass |
| M-11 | 中 | 已修复 | 下载串行队列 + 重复回调去重 |
| M-12 | 中 | 已修复 | 通知授权等待队列 + grant 后重放 |
| M-13 | 中 | 已修复 | desktop-parity 默认 stable，alpha 显式 opt-in |
| M-14 | 中 | 已修复 | Node headers 复制移除 `cp -a` hard-link 风险 |
| M-15 | 中 | 已修复 | OTA manifest/snapshot streaming size cap |
| M-16 | 中 | 已修复 | 默认 OTA endpoint 为空，不再指向 10.0.2.2 |
| M-17 | 中 | 已修复 | 全局 cleartext 关闭，仅本机 DSH origin 放行 |
| L-01 | 低 | 已修复 | Shizuku 文案与真实能力一致 |
| L-02 | 低 | 已修复 | 顶栏应用设置复用 DSH Settings UI 图标 |
| L-03 | 低 | 已修复 | snapshot 诊断架构修正为 arm64 |

## 回归检查

```bash
bash scripts/check-severe-fixes.sh
bash scripts/check-high-fixes.sh
bash scripts/check-remaining-fixes.sh
```

第三个脚本额外验证 Manifest / network-security XML、WebView 注入 JS 语法及 Git askpass 精确 host 隔离。

> 以上为源码静态回归和事务逻辑检查结果。最终 APK 仍应在目标 Android 设备上执行冷启动、二次进入、插件 npm/Git/ZIP 安装、私有 Git、SSH、工作区导入和多文件下载回归测试。
