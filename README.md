# DeepSeek Harness Mobile Enhance

[English](README_EN.md)

基于 [dsh-mobile](https://github.com/thness/dsh-mobile) 与 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 优化重构的 **Android / Mobile DeepSeek Harness 客户端**，重点增强工作区文件管理、插件安装、UI 切换、Android/Termux 兼容性与运行稳定性。

> 当前版本：**V0.1**  
> Android：`minSdk 26` / `targetSdk 34` / `compileSdk 36`  
> 主要架构：`arm64`

## 主要功能

- Android 本机运行 DeepSeek Harness，无需桌面端常驻服务
- 支持本地**文件 / 多文件 / 文件夹**导入工作目录
- 支持插件安装、启用、禁用、卸载与兼容性处理
- 支持**移动端 UI / DSH 原生 UI**切换
- 提供 Workspace、Terminal、Git / SSH、文件搜索等能力
- 增强 Android / Termux 环境下的 Node、`node-pty`、Koffi、Sharp、ripgrep 等兼容性
- 优化启动、文件处理、异常恢复与运行时诊断

## 构建

推荐在 Termux 中使用项目构建脚本：

```bash
bash build-termux.sh
```

APK 默认输出：

```text
app/build/outputs/apk/debug/app-debug.apk
```

构建脚本会准备并校验 DSH、Node、pnpm、npm、ripgrep、Git / SSH、原生 Node 模块及 Android 兼容补丁。

## 项目目标

在保留 DeepSeek Harness 核心能力的基础上，进一步完善移动端：

```text
Workspace + 文件管理 + 插件系统 + UI 切换
+ Android 兼容性 + 稳定性 + 性能优化
```

使其更适合作为可长期维护和扩展的 Android Harness 客户端。

## 上游项目

- [thness/dsh-mobile](https://github.com/thness/dsh-mobile)
- [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)

## License

本项目采用 [MIT License](LICENSE)。第三方依赖继续遵循各自的许可证与版权声明。
