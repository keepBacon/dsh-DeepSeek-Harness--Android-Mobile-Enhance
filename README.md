# DeepSeek Harness Mobile V0.1.1

> **DeepSeek Harness Mobile Enhance：面向 Android 的 DeepSeek Harness 增强版，重点强化工作区文件导入、插件安装、UI 切换、Termux/Android 兼容性与移动端稳定性。**

[English](README_EN.md)

DeepSeek Harness Mobile 是面向 Android 的 DeepSeek Harness 独立运行外壳。应用在本机启动 DSH Host，并通过受限的 Android WebView 提供移动端界面，同时保留插件、工作区、终端、Git/SSH 与文件搜索等能力。

> 当前应用版本：**V0.1.1**  
> 默认 DSH：`@deepseek-ai/dsh 0.1.5-rc.2`  
> Android：`minSdk 26` / `targetSdk 34` / `compileSdk 36`  
> 主要架构：`arm64`

## 功能

- Android 本机运行 DeepSeek Harness，不依赖桌面端常驻服务。
- 提供移动端布局与 DSH 原生布局切换。
- 支持工作区目录、文件导入、附件上传与会话导出。
- 支持将本地单文件、多文件和文件夹导入当前工作目录，并保留目录结构。
- 支持 npm、GitHub、Git、SSH、本地 ZIP/Tarball 等插件来源。
- 提供插件安装、启用、禁用、卸载、兼容性检查与错误日志能力。
- 内置 pnpm、npm/npx、ripgrep、Git、OpenSSH、CA bundle 等运行时能力。
- 内置 Termux 兼容工具层：`pkg` / `apt` / `dpkg`、Python 3 / pip，以及常用 CLI 工具，模型可直接在终端/工具调用中使用。
- 针对 Android/Termux 环境处理 `node-pty`、Koffi、Sharp、ripgrep resolver、动态库加载和 W^X 等兼容问题。
- 设置页提供项目 GitHub 仓库入口。
- 运行时缺失或损坏时提供诊断与修复流程。
- 针对手机、横屏和平板持续优化响应式布局与交互体验。

## 工作区与文件导入

文件导入能力面向 Android 现代存储模型设计，优先兼容 Storage Access Framework、`content://` URI 与 Scoped Storage。

支持：

- 单文件导入
- 多文件导入
- 文件夹递归导入
- 保留原始目录结构
- 文件重名处理
- 大文件异步复制
- 导入完成后自动刷新工作区文件树

文件与目录访问逻辑应尽量统一到工作区与存储管理层，避免业务 UI 直接依赖绝对路径。

## 插件系统

插件系统用于在移动端直接管理 DeepSeek Harness 扩展能力。

支持方向包括：

- 本地 ZIP / Tarball 安装
- 本地目录安装
- npm 插件来源
- GitHub / Git 仓库安装
- 插件版本检测
- 插件兼容性检测
- 启用 / 禁用
- 卸载
- 插件错误日志

插件安装与解压过程应包含基础路径安全检查，避免路径穿越、异常覆盖和无边界解压。

第三方插件出现异常时，应尽量隔离错误，避免单个插件导致整个应用退出。

## UI 与界面切换

项目提供移动端布局与 DSH 原生布局切换，并计划持续增强多种 UI 模式。

界面切换重点保证：

- 当前工作目录不丢失
- 已打开内容尽量保持
- Terminal Session 尽量保持
- 页面状态尽量保持
- 减少不必要的 Host / Harness 重启

UI 优化优先级：

```text
功能
>
信息层级
>
操作反馈
>
动效
>
装饰
```

避免为了视觉效果引入过多渐变、Glow、玻璃效果、重阴影或无意义动画。

## Android 文件系统兼容

Android 不同版本的文件访问行为差异明显，因此项目优先适配现代 Android 文件系统。

重点覆盖：

- Android 8+
- Storage Access Framework
- Scoped Storage
- `ACTION_OPEN_DOCUMENT`
- `ACTION_OPEN_DOCUMENT_TREE`
- `ContentResolver`
- `content://` URI

文件导入不应假设用户选择结果一定可以转换成传统：

```text
/storage/emulated/0/...
```

路径。

## GitHub

项目仓库：

https://github.com/keepBacon/dsh-DeepSeek-Harness--Android-Mobile-Enhance

应用内可通过：**顶部设置 → 应用设置 → GitHub 仓库** 打开。

## Termux 构建

安装依赖：

```bash
pkg update -y
pkg install openjdk-17 nodejs-lts clang cmake ninja make python python-pip proot \
  binutils pkg-config libandroid-spawn ripgrep git openssh ca-certificates \
  curl jq unzip zip tar gzip xz-utils coreutils findutils grep sed gawk less which procps file \
  apt dpkg termux-tools termux-keyring aapt2 -y
```

解压源码后执行：

```bash
cd /storage/emulated/0/Download
unzip dsh-mobile-v0.1.1-source.zip
cd dsh-mobile-v0.1.1
bash build-termux.sh
```

APK 输出位置：

```text
app/build/outputs/apk/debug/app-debug.apk
```

`build-termux.sh` 不只是 Gradle 包装脚本。它还会准备并校验 Android runtime，包括 DSH、Node、pnpm、npm、ripgrep、Git/SSH、原生 Node 模块和兼容补丁。除非已经准备好完整 `snapshot.tar.xz`，否则不建议直接跳过它只运行 `./gradlew assembleDebug`。

## 运行时说明

运行时快照位于：

```text
app/src/main/assets/snapshot.tar.xz
```

它必须是为 Android/Termux 准备并经过本项目兼容处理的快照，不能直接替换为普通 Linux rootfs。

构建脚本会检查至少以下关键组件：

```text
usr/bin/node
usr/lib/node_modules/@deepseek-ai/dsh/lib/bin.js
usr/lib/libtermux-exec-ld-preload.so
```

V0.1.1 的交互终端使用内置的真实 Termux Bash。运行时通过稳定包装入口调用：

```text
usr/bin/bash
→ usr/libexec/dsh/bash-real
```

并保留 `/system/bin/sh` 作为 Android 系统脚本兼容入口。其他可能逃逸解压根目录的绝对链接和路径穿越仍会被拒绝。

## 内置 Termux 工具环境

V0.1.1 的 runtime 不再只是“Termux 风格目录”。完整构建会把一组经过依赖闭包解析的 Termux 工具包打进应用，包括：

- `pkg` / `apt` / `dpkg`
- Python 3 / pip
- coreutils / findutils / grep / sed / gawk
- tar / gzip / xz / unzip / zip
- curl / jq / less / which / procps / make
- aapt2（供 APK 清单/权限/ABI 等结构分析）
- 以及上述工具的实际运行依赖

由于官方 Termux 包通常编译时绑定 `/data/data/com.termux/files/usr`，应用不会假装自己的私有前缀就是原版 Termux。对需要该固定前缀的命令，runtime 通过 PRoot 兼容命名空间把：

```text
/data/data/com.dshmobile.shell/files/usr
```

映射到：

```text
/data/data/com.termux/files/usr
```

因此终端和模型可以直接执行：

```bash
python3 --version
python3 script.py
pip install <package>

pkg list-installed
pkg install <package>
apt update
apt install <package>
```

包管理器安装的新文件仍实际写入本应用自己的私有 `files/usr`，不会修改独立 Termux 应用的数据。

可通过构建环境变量扩展预装工具：

```bash
DSH_EXTRA_TERMUX_PACKAGES="ffmpeg openssl-tool" bash build-termux.sh
```

## 工作目录文件边界

Android 壳现在把 **当前 DSH Session 的 `cwd` / Workspace 路径**作为 Web 文件操作的唯一根目录：

- 对话框、Composer 和其它 Web `<input type="file">` 不再打开 Android 全局文件选择器，而是在当前工作目录及其子目录内选择文件。
- DSH 会话导出以及同源 Web 下载不再写入系统 `Downloads`；导出前只允许在当前工作目录内部选择目标子目录，并支持在该范围内新建文件夹。
- Android 壳从当前 Web Session 的 `session/list` 摘要同步 `cwd`，切换 Workspace 后文件根目录随当前 Session 更新。
- 所有选择均做 canonical-path containment 检查，并排除符号链接，禁止通过 `..`、symlink 或路径替换跳出 Workspace。
- 返回给 WebView 的文件使用私有 `FileProvider` content URI；Provider 不导出，只有已经通过 Workspace 边界检查的文件才会被构造 URI。
- 应用设置中的“从手机复制到工作区（维护）”仍保留，它只是把外部手机文件复制进 Workspace 的显式维护入口，不属于对话/模型的文件浏览域。

## 内置 basic_tools MCP

Android Runtime 现在除 `mobile_tools` 外，额外内置独立的 `basic_tools` MCP。两者使用不同命名空间：`mobile_tools` 保持逆向/动态分析能力，`basic_tools` 专注通用开发与工作区操作。

`basic_tools` 当前提供 52 个结构化工具，覆盖：文件/目录信息与修改、压缩包、JSON/YAML/TOML/XML/CSV、SQLite、文本 diff/replace/regex、环境与磁盘、端口/DNS/TCP/TLS、证书与编码、Git、构建/测试检测、Gradle/npm/CMake、ImageMagick、FFmpeg/ffprobe、PDF 元信息和目录 SHA-256 manifest。

对应 Termux Runtime 会一并打包 `7zip`、`yq`、`sqlite`、`cmake`、`ninja`、`iproute2`、`dnsutils`、`imagemagick`、`ffmpeg`、`poppler`，构建阶段会检查关键命令实际存在并运行 smoke test。

## Android Desktop Backend Parity

Android standalone keeps the upstream DSH 0.1.5-rc.2 Web/workspace composition and adapts only host capabilities that assume a desktop OS:

- **Workspace / filesystem:** the official `dsh-fs-sandbox` remains active. Model-controlled writes and edits still use canonical workspace containment; the Android phone-file import/export bridge only copies to or from the selected DSH workspace.
- **Process sandbox:** `dsh-sandbox-local` uses an Android-specific app-UID runner when `DSH_ANDROID_STANDALONE=1`. It reports `partial` enforcement rather than pretending Android provides desktop Linux `bwrap`/Landlock confinement.
- **Subprocess:** `dsh-subprocess-local` skips desktop Linux systemd-scope probing on Android and uses its supported fallback process/session containment path.
- **Terminal:** `dsh-terminal-bash` resolves the APK's embedded Bash through `DSH_SIDEBAR_SHELL` / `SHELL` instead of the desktop default `/bin/bash`.
- **Directory picker:** the upstream Web `directory-picker-auto` naturally selects the browse backend on Android; the mobile UI adaptation does not replace the authoritative workspace backend.
- **Core desktop Web capabilities:** workspace files/controller, Git/SSH, plugins, Skills, MCP, Bash, FS/FS search, jobs, subagents, workflows and Web tools stay on the official DSH composition. Android compatibility work preserves those services instead of maintaining a reduced parallel backend.

Android cannot provide byte-for-byte desktop kernel behavior without root or a desktop kernel. The process sandbox therefore advertises `partial` enforcement; the app UID is the outer OS isolation boundary and DSH filesystem containment remains the authoritative model-write fence.

## No-Root Runtime Analysis

`mobile_tools` 3.2 以 **无 Root / 无 Shizuku 优先** 重新组织动态分析路径。默认先使用普通 App UID 可以访问的自身/同 UID `/proc`、FD/socket、运行时快照和子进程 `strace`；对于需要更高 Android 调试权限但仍不需要 Root 的场景，支持用户主动开启并配对 **Wireless Debugging / ADB**。

新增工具：

- `no_root_capabilities`
- `self_runtime_snapshot`
- `runtime_snapshot`
- `runtime_diff`
- `process_fds`
- `process_network`
- `child_strace`
- `adb_devices`
- `adb_pair`
- `adb_connect`
- `adb_package_info`
- `adb_process_info`
- `adb_logcat`
- `adb_jdwp_list`
- `adb_pull_apk`

ADB 路径依赖用户在 Android 开发者选项中主动打开“无线调试”并完成一次性配对；它不会绕过系统授权。Frida/GDB/debuggerd/其它应用 `/proc`/内存读取仍保留为条件增强能力，仅在 Android UID/SELinux/debuggable/root/授权后端实际允许时使用。

## Runtime Reverse Analysis Foundation

`mobile_tools` 3.1 在已有进程/内存只读、Frida、GDB、Rizin、JNI 与 IL2CPP 基础能力上补齐运行时分析链路：

- `reverse_capabilities`：检测 /proc、root、Frida、GDB/gdbserver、strace、Rizin、debuggerd、addr2line/nm 等实际可用性。
- `package_process_info`：包名解析 PID/UID/APK 路径/dataDir/ABI/debuggable。
- `native_backtrace`：通过 Android `debuggerd -b` 请求授权/可调试进程的 native backtrace。
- `frida_attach(..., persistent=true)` / `frida_spawn(..., persistent=true)` + `frida_detach`：受管持久 Frida session。
- `symbol_resolve`：runtime VA → mapping/module/load bias/RVA/addr2line/nearest symbol。
- `address_rebase`：以 BigInt 做 module base / RVA / runtime VA 精确换算。
- `il2cpp_metadata_info`：验证 `global-metadata.dat` magic/version，并解析 header section offset/size。
- `il2cpp_find_class`：只在已验证 metadata string table 中定位 class/namespace 名称，不伪造 class index/RVA。

内存能力仍保持只读：提供 `memory_regions/read/search`，不内置任意 `memory_write`。对其它应用的 /proc、ptrace、debuggerd、Frida 等访问仍受 Android UID/SELinux、debuggable、root 或授权调试后端约束；工具会返回权限/可用性诊断，不假定可以越权访问。

## 内置 mobile_tools MCP

内置 MCP 工具箱面向模型直接调用，参数尽量统一：路径既可使用绝对路径，也可相对 MCP 当前工作目录；目录/仓库类工具默认使用当前目录；超时和输出上限均有安全默认值。常规源码修改优先使用结构化文件工具，不要求模型自己拼 Shell 命令。

当前直接提供：

- 文件/源码：`fs_read`、`fs_list`、`fs_search`、`fs_write`、`fs_patch`
- 命令：`command_run`（直接 argv，`shell=false`，返回 exitCode/stdout/stderr/耗时）
- Git：`git_status`、`git_diff`、`git_log`
- 网络：`http_request`
- Android：`android_logcat`、`apk_inspect`
- 动态分析：`process_list/process_info/process_maps/process_threads/module_list`、`memory_regions/memory_read/memory_search`、`syscall_trace`
- Frida：`frida_processes/frida_attach/frida_spawn/frida_script/frida_trace`
- GDB：持久 `debug_session_start` 会话、attach、断点、continue、寄存器、backtrace、内存读取
- Rizin/JNI/IL2CPP：`binary_functions`、`binary_xrefs`、`jni_map_java_native`、`il2cpp_detect`、`il2cpp_find_method`
- 协议：decode / encode / hash / HTTP / URL
- ELF：信息、Section、Symbol、Strings、反汇编

推荐模型调用链：

```text
fs_search → fs_read → fs_patch → git_diff → command_run(构建/测试)

process_list → module_list/process_maps → binary_functions/binary_xrefs
→ frida_script 或 debug_session_start → debug_backtrace/debug_registers
```

动态工具默认不会绕过 Android 的进程隔离。分析其他应用时，目标必须是可调试/同 UID，或设备已由用户自行提供允许 ptrace/Frida 的 root/debug 环境。Frida 客户端与 server 二进制会随 Runtime 打包，但不会由应用静默提权或自动启动 root 服务。Termux 当前把 Frida 拆成 `frida`（server）与 `frida-python`（CLI）两个包；GDB 的远程后端同样拆成独立 `gdbserver` 子包。构建器会安装这些真实 provider，并在 staging 前根据每个可执行文件的实际 dpkg owner 自动扩充包闭包。Frida CLI 的 pip 运行时依赖也会显式复制并通过 `frida-ps --help` / `frida-trace --help` smoke test 验证。

构建动态工具链时会先做宿主 ABI smoke：GDB/gdbserver/strace/Rizin/Frida 即使“已安装”，也必须真正能启动；若检测到类似新 GDB + 旧 libc++ 的部分升级状态，构建器会通过隔离软件源重装对应 ABI 家族，再把同一套 ELF 依赖与 libc++ 同步进 staged Runtime。只有缺包或检测到 ABI 损坏时才联网。除此之外，构建动态工具链时不会再无条件刷新宿主 Termux 软件源：只有缺少 GDB/strace/Rizin/Frida 等包时才联网，且使用隔离的临时 APT source/list；默认先访问 `https://packages.termux.dev/apt`，失败再回退 `https://packages-cf.termux.dev/apt`。这不会改写用户 Termux 的 `sources.list`。如果所需包已经安装，构建可直接离线进入 staging。可通过 `DSH_TERMUX_PRIMARY_APT_BASE` / `DSH_TERMUX_FALLBACK_APT_BASE` 覆盖两个构建期镜像。

这样模型可以完成“定位 → 阅读 → 修改 → 审查 diff → 构建验证”，以及“静态定位 → 运行时模块基址 → 动态观察 → 回到静态 XREF”的闭环。

## Shell / Terminal 兼容

移动端 Shell 环境与普通 Linux 桌面存在明显差异。

项目重点处理：

- Shell 路径
- PATH
- HOME
- TMPDIR
- LANG
- Working Directory
- executable permission
- Android/Termux 动态库路径

运行时不应假设 `/bin/bash` 一定存在，应根据实际环境检测可用 Shell。

## 外部工具兼容

涉及以下工具时应先检测可用性：

- Git
- Node.js
- npm / npx
- pnpm
- Python
- ripgrep
- OpenSSH
- tar
- unzip

缺少工具时应提供明确错误信息，而不是在执行流程中途直接失败。

## WebView 兼容

如果 Harness 页面通过 Android WebView 承载，应重点处理：

- Android System WebView 版本差异
- JS Bridge 异常
- 页面加载失败
- WebView 崩溃恢复
- 文件上传
- 外部 URL 跳转
- Cookie 与缓存
- 本机 Host 权限边界

高权限 Android Bridge 只应对可信本机页面开放。

## 错误处理与日志

项目应尽量统一错误分类与日志输出。

重点模块包括：

- Workspace
- Plugin
- Terminal
- API
- UI
- Process
- Storage
- Network
- Git

用户界面应优先显示可理解的错误原因，同时保留详细日志用于排查。

例如，不建议只显示：

```text
Network Error
```

而应尽量指出：

- 连接超时
- DNS 失败
- 权限不足
- 目标文件不可访问
- 插件版本不兼容
- 外部工具缺失
- 运行时组件损坏

## 性能优化

重点优化方向：

- 冷启动速度
- 工作区文件扫描
- 大目录加载
- 大文件复制
- Terminal 大量输出
- 插件加载
- WebView 初始化
- UI 重绘
- 后台任务调度
- 内存占用

文件复制、解压、Git、插件安装、目录扫描等耗时任务应尽量在后台执行，避免阻塞 Android UI 主线程。

大型目录应优先采用懒加载和增量刷新，而不是每次变化都重新扫描完整工作区。

## 内存与大文件处理

针对大文件和长时间运行场景：

- 避免一次性读取整个大文件到内存
- 使用流式 I/O 和缓冲区复制
- 限制无限增长的 Terminal 历史
- 及时关闭文件流
- 避免 WebView / Activity Context 泄漏
- 避免长期持有不必要的大对象

## 兼容性目标

重点覆盖：

```text
Android 8–15+
arm64-v8a
armeabi-v7a（视运行时依赖支持情况）
x86_64（视运行时依赖支持情况）
```

如果某个 ABI 或运行时组件不可用，应在启动或功能执行前给出明确提示，而不是直接触发 `UnsatisfiedLinkError` 等底层崩溃。

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
README.md               中文说明
README_EN.md            English documentation
```

## 项目目标

本项目并不是只为 DeepSeek Harness Mobile 增加几个功能入口，而是希望逐步形成一个更稳定、完整、可长期维护的 Android Harness 工作环境：

```text
DeepSeek Harness
+
Android Native Host
+
Workspace
+
文件 / 文件夹导入
+
插件系统
+
UI 切换
+
Terminal
+
Git / SSH
+
兼容性增强
+
稳定性与性能优化
```

核心目标是在保留上游能力的基础上，让 DeepSeek Harness 在 Android / Termux 环境下更加稳定、易用，并具备持续扩展能力。

## License

本项目源码采用 [MIT License](LICENSE)。

第三方依赖保留各自许可证与版权；本项目的 MIT License 不会替代或改变第三方项目的许可条件。
