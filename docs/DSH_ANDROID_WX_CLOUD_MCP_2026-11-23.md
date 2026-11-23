# DSH Android W^X 工具链恢复与云端 MCP 执行

## 本地根因与修复

Android 的应用数据目录不可作为通用 ELF `execve` 位置。仅把
`/data/user/0/com.dshmobile.shell/files/usr/bin` 加入 PATH 或 chmod +x
不会修复。现有 DSH 的 `/system/bin/sh -> android-exec.sh ->
/system/bin/linker64` 仍然是统一的私有 ELF/解释器调用路径；
无需 Root、修改 SELinux 或降低 targetSdk。

原来 `android-bash-env.sh` 为了防止 noexec 私有 wrapper 被系统
`execve` 直接调用，故意将 PATH 限定为
`/system/bin:/system/xbin`，仅在真正出现 command-not-found 时执行
桥接。这导致 `command -v python3`、`command -v clang++` 等无法发现
工具，很多安装/编译脚本会在真正执行前提前退出。

现在每次非交互式 Bash 启动时，从实际 `usr/bin/` 文件名建立经过
校验的 Bash 分发函数，不把不可执行目录加入 PATH；前者使
`command -v` 和脚本内命令查找可靠可见，执行时仍通过
`android-exec.sh` 和现有 termux wrapper。Node Host 的子进程环境
显式设置 `BASH_ENV`，不修改用户的 `~/.bashrc`、profile、插件或会话。

**限制**：这是对 Bash *命令名分发* 的修复，不是绕过 Android SELinux。
在 Bash 输入完整的 `/data/.../usr/bin/python3` 仍可能直接
`execve` 失败；应使用 `python3`（Bash 分发函数），或
`/system/bin/sh "$TERMUX__PREFIX/libexec/dsh-mobile/android-exec.sh"
"$TERMUX__PREFIX/bin/python3" --version`。单个 ELF 的 ABI/动态库或
静态链接问题仍要按具体错误修复。交互式用户 Shell 的个人启动文件
可能与非交互式 Bash 不同，尚需真机按 Shell 类型逐一验收。

## 实际运行探针

在 DSH MCP `mobile_tools` 中调用：

`runtime_toolchain_probe({"extended": false})`

会按顺序尝试 Node、Python3、Git、SSH 的轻量 `--version` 调用，
按真实退出码报告 `installed` 与 `runnable`。启用
`extended:true` 才测试 Clang 和 QEMU。不会仅因程序文件存在就报告
可用，不会并行启动重量级工具。这里的内存估计来自
`/proc/meminfo`，是**系统级**指标，不是 Android app 的精确内存上限。

如未能启动，请按 `reason`、`exitCode`、`detail` 判断是否为
动态链接器错误、二进制不兼容、W^X 或 Android 分区限制；
不应对无法运行的工具伪造成功。

## 云端 MCP 适配

DSH Android 原生设置 -> **管理 MCP / 协议 / 逆向工具** ->
**GitHub Actions 云端工具（官方远程 MCP）**。

- 自动填入官方 Streamable HTTP URL：
  `https://api.githubcopilot.com/mcp/x/actions`。
- 工具命名空间：`cloud_actions`。
- 使用已有 Android Keystore 保存 GitHub Bearer Token；
  不把明文写进 DSH Profile、Cordis patch 或工作流文件。
- Token 需要对应仓库 Actions 读取及 `workflow_dispatch` 触发权限。
  GitHub 官方远程 MCP 的 OAuth 可用性依赖具体宿主；此预设使用
  HTTP Bearer Token，不宣称自动实现 OAuth。
- 安装后，工具来自官方 `@deepseek-ai/dsh-mcp-client`，
  不是在插件市场输入 `GitHub MCP Server` 这个显示名称。
- 如远程 MCP 认证失败或工具未出现，保留实际错误；不伪造云端执行。

## 可触发的 GitHub Actions 真实执行

新工作流：`.github/workflows/dsh-cloud-analysis.yml`。

| task | GitHub Runner | 真正执行的操作 |
|---|---|---|
| `jadx` | Linux x64 + Java 21 | JADX 1.5.7 CLI 反编译 APK/DEX |
| `ghidra` | Linux x64 + Java 21 | Ghidra 12.0.4 Headless 导入和分析 |
| `linux-x64` | Linux x64 | file/readelf/hash/受限字符串扫描 |
| `windows-pe` | Windows x64 | PE 文件 Hash/Authenticode 静态检查；**不启动 EXE** |

在自己有权限分析的项目仓库下放置
`cloud-inputs/sample.apk`（请勿把私有数据提交到公共仓库）。
模型通过官方 GitHub Actions MCP 的工作流触发工具，向
`dsh-cloud-analysis.yml` 传入：

`{"task":"jadx","input_path":"cloud-inputs/sample.apk"}`

JADX 和 Ghidra 使用固定的 GitHub Release 工具资源和 SHA-256；
不会直接执行不受信任的任意命令、外部 URL 或第三方 EXE。
实际结果保存为 GitHub Actions logs 和 `dsh-cloud-*` artifact，
留存 7 天。浏览器侧可以下载并将报告交给 DSH。

*GitHub Actions 用量可能产生费用。普通 GitHub Runner 不提供长期
在线 SSH Shell；这套适配是受限的云端任务执行，不是无限制 VPS。
Burp Suite GUI 等需要持续交互式桌面的工具，仍须独立 VPS/远程桌面
环境。*

## 验收边界

CI 包含 Bash 发现与安全 PATH、工具真实退出码分类、云端输入
路径/ZIP 防穿越测试及 Android Gradle 组装。由于 GitHub CI 不在
你的手机 UID 下，仍须安装新签名 APK，在真机运行
`runtime_toolchain_probe`、`python3 --version` 和
`clang --version`，验证 `linker64` 是否真正能运行。云端
JADX/Ghidra 工作流需在合并进 main 且有合法输入样本后显式触发，
不能以 YAML 文件存在视为云端任务已完成。
