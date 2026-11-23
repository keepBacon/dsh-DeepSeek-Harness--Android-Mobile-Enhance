# DSH Android Python / pip / PEP 517 子进程 W^X 修复（2026-11-23）

## 实际问题与边界

Android DSH 的 Termux prefix 位于应用私有数据目录。该目录的
W^X/noexec 限制使直接 `execve("/data/.../files/usr/bin/python3")`
失败；即使 shell 的 PATH 或 chmod 正确也一样。现有 Python 本体已能
由 `/system/bin/sh → android-exec.sh → linker64` 启动，但 pip、
setuptools、PEP 517 build isolation 仍可能通过 `subprocess.Popen`
启动 `sys.executable`、`/usr/bin/python3`、旧 Termux 编译路径或
位于私有 HOME 中的脚本，而绕过上述桥接。

这轮没有删除 Python、插件、pip 缓存、用户包或配置；也不修改
Android targetSdk、SELinux 或 DAC 文件权限。

## 代码修复

- 在打包内置 Python 的 `usr/lib/python*/site-packages/` 安装
  `dsh_android_subprocess.py` 和 `dsh_android_noexec.pth`，按标准
  Python site 初始化自动加载。比仅设置 `PYTHONPATH` 更适合处理
  pip/PEP517 子进程独立设置 PYTHONPATH 的场景。
- 仅当 `DSH_ANDROID_STANDALONE=1` 且 `TERMUX__PREFIX` 属于
  Android 应用数据路径时激活；仅重写应用私有 ELF/#！脚本以及已知
  的 `/usr/bin/python[3]`、旧 `com.termux` Python/Clang 编译路径。
  系统命令、其他应用的文件、`shell=True`、显式指定的
  `executable` 不改写，不替换全局 os.exec*。
- 通过原有 `/system/bin/sh`、`android-exec.sh`、
  `/system/bin/linker64` 启动目标，同时保留原进程的 argv、cwd、
  env、stdout/stderr、timeout、退出码和取消行为。
- Python 构建进程未指定时才设置 `CC`、`CXX`、`LDSHARED`
  到相同的 linker 路由；保留用户显式设置的编译器参数。
- 新增 `mobile_tools.runtime_python_build_probe`，在**真实 Android
  应用 UID** 下执行 `subprocess.run([sys.executable,...])`，验证子进程
  是否能真正执行、适配器是否已加载。此探测不运行 pip、不访问网络，
  不使用用户凭据或编译 C 扩展。
- 增加真实 Linux subprocess 单测、模拟应用私有 prefix 的打包
  `.pth` 测试、正式 ARM64 archive 内容验证；只有整套测试通过，
  才按原有 CI 流程构建签名 APK。

## 验收流程

在安装新版签名 APK 后，先运行：

`runtime_python_build_probe({})`

必须观察到 `adapterLoaded=true`、`nestedChildOk=true`。

然后分别测试：

1. `python3 -m pip --version`
2. `python3 -m pip download --only-binary=:all: six -d <自有目录>`
3. `python3 -m pip install --only-binary=:all: six`
4. 在有编译环境且内存足够时，单独尝试
   `python3 -m pip install --no-build-isolation lupa`。

这些步骤各自可失败；不自动反复安装、替换用户包或重复联网。
第 4 项仍取决于 Android Bionic ABI、Python headers、C++ 工具链、
liblua 等依赖、CFLAGS/LDFLAGS 和剩余可用内存。

**重要区分**：纯 Python wheel 的 `pip download` 一般不需要本地
编译；它不天然受同一构建 subprocess 故障影响。源码包、动态元数据
生成以及 PEP 517 构建 isolation 可能会触发子进程。不能因为没有
Android 兼容 wheel 就把 Linux x64/manylinux wheel 当作 Android
可运行产物。云端 Linux/glibc 编出的 wheel 通常也**不能**直接用于
Termux 的 Android/Bionic Python。

## 已知限制

- Python `subprocess.Popen` 之外的原生 C/C++ `execve`、
  `os.exec*`、不加载 site 包的 `python -S` 或 `python -I`
  启动不在此轮 Python 适配范围内，仍依赖已有 native LD_PRELOAD /
  Termux CLI 桥接或需要专门的启动器。
- `Lupa` 是编译型 Python 扩展。即使 Python 构建后端恢复，也不能
  保证已有 235 MB 可用内存足以完成编译。若仍缺少资源，优先尝试
  Termux 原生 ABI 包或远端 Android/NDK 专用构建；不可使用普通
  glibc/Linux wheel 假装成功。
- CI 仅验证跨平台 Python 启动逻辑与打包约束；真实 ARM64 ELF 的
  linker、动态库与内存行为必须在设备上验收。
