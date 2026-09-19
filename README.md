# DeepSeek Harness Mobile V0.1

DeepSeek Harness Mobile 是面向 Android 的 DeepSeek Harness 独立运行外壳。应用在本机启动 DSH Host，并通过受限的 Android WebView 提供移动端界面，同时保留插件、工作区、终端、Git/SSH 与文件搜索等能力。

> 当前应用版本：**V0.1**  
> 默认 DSH：`@deepseek-ai/dsh 0.1.5-rc.2`  
> Android：`minSdk 26` / `targetSdk 34` / `compileSdk 36`  
> 主要架构：`arm64`

## 功能

- Android 本机运行 DeepSeek Harness，不依赖桌面端常驻服务。
- 提供移动端布局与 DSH 原生布局切换。
- 支持工作区目录、文件导入、附件上传与会话导出。
- 支持 npm、GitHub、Git、SSH、本地 ZIP/Tarball 等插件来源。
- 内置 pnpm、npm/npx、ripgrep、Git、OpenSSH、CA bundle 等运行时能力。
- 针对 Android/Termux 环境处理 `node-pty`、Koffi、Sharp、ripgrep resolver、动态库加载和 W^X 等兼容问题。
- 设置页提供项目 GitHub 仓库入口。
- 运行时缺失或损坏时提供诊断与修复流程。

## GitHub

项目仓库：

https://github.com/keepBacon/dsh-DeepSeek-Harness--Android-Mobile-Enhance

应用内可通过：**顶部设置 → 应用设置 → GitHub 仓库** 打开。

## Termux 构建

安装依赖：

```bash
pkg update -y
pkg install openjdk-17 nodejs-lts clang cmake ninja make python binutils pkg-config \
  libandroid-spawn ripgrep git openssh ca-certificates \
  curl unzip tar xz-utils aapt2 -y
```

解压源码后执行：

```bash
cd /storage/emulated/0/Download
unzip dsh-mobile-v0.1-source.zip
cd dsh-mobile-v0.1
bash build-termux.sh
```

APK 输出位置：

```text
app/build/outputs/apk/debug/app-debug.apk
```

`build-termux.sh` 不只是 Gradle 包装脚本。它还会准备并校验 Android runtime，包括 DSH、Node、pnpm、npm、ripgrep、Git/SSH、原生 Node 模块和兼容补丁。除非你已经准备好完整 `snapshot.tar.xz`，否则不建议直接跳过它只运行 `./gradlew assembleDebug`。

## 运行时说明

运行时快照位于：

```text
app/src/main/assets/snapshot.tar.xz
```

它必须是为 Android/Termux 准备并经过本项目兼容处理的快照，不能直接替换为普通 Linux rootfs。构建脚本会检查至少以下关键组件：

```text
usr/bin/node
usr/lib/node_modules/@deepseek-ai/dsh/lib/bin.js
usr/lib/libtermux-exec-ld-preload.so
```

V0.1 同时保留对 Android 系统 Shell 合法绝对符号链接 `usr/bin/bash -> /system/bin/sh` 的安全兼容；其他可能逃逸解压根目录的绝对链接和路径穿越仍会被拒绝。

## 使用的开源项目

本项目基于并使用以下两个主要开源项目：

| 项目 | 用途 | 上游 |
| --- | --- | --- |
| dsh-mobile | Android 移动端实现基础与运行时封装参考 | https://github.com/thness/dsh-mobile |
| DeepSeek Harness | 核心 Harness、Web UI 与插件体系 | https://github.com/deepseek-ai/deepseek-harness |

以上两个上游仓库当前均采用 MIT License。构建产物中包含的其他第三方组件仍分别遵循其自身许可证与版权声明，但不在此处逐项列出。

## 安全设计

- WebView 的特权 Android bridge 使用每次 Activity 生命周期随机生成的 capability 进行调用校验。
- DSH 页面仅允许可信本机 Host 在 WebView 内使用高权限桥；外部 URL 交由系统浏览器处理。
- 插件 ZIP 解压包含路径穿越、文件数量、目录深度、单文件和总大小限制。
- SSH 私钥和私有 Git HTTPS token 使用 Android Keystore 保护。
- 运行时 TAR 解压包含路径逃逸检查，并仅对白名单 Android 系统链接进行兼容。
- 第三方插件构建脚本不会无条件执行；pnpm 11 的 build approval 仍需要显式授权。

## 项目结构

```text
app/                    Android 应用
app/src/main/assets/    运行时快照与版本信息
scripts/                Android runtime patch / 回归检查
build-termux.sh         Termux 完整构建入口
build-offline-termux.sh 离线构建入口
CHANGELOG.md            历史变更记录
LICENSE                 项目许可证
```

## License

本项目源码采用 [MIT License](LICENSE)。

第三方依赖保留各自许可证与版权；本项目的 MIT License 不会替代或改变第三方项目的许可条件。
