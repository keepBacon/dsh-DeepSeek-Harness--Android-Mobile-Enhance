# DSH Android ARM64 developer runtime

## Compiler and build tools

The signed APK bundles native Android/aarch64 Termux Clang/Clang++, Make, CMake, Ninja, LLVM, LLD, pkg-config and QEMU's Linux x86_64 **user-mode** emulator. GCC and G++ names are compatibility aliases to Clang, not genuine GNU GCC. QEMU does not run Windows DLLs or kernel drivers.

Verify commands on the actual Android phone:

~~~sh
clang --version
clang++ --version
gcc --version
make --version
cmake --version
ninja --version
ld.lld --version
pkg-config --version
qemu-x86_64 --version
python3 -m pip --version
python3 -m venv --help
~~~

A version response is **not** a successful compile/link. Compile a C/C++ smoke source in a user-owned directory (not the packaged runtime) and use the Android system-linker bridge to execute the app-private resulting ELF:

~~~sh
mkdir -p "$HOME/dsh-compiler-check"
cd "$HOME/dsh-compiler-check"
printf '#include <stdio.h>\nint main(void){puts("DSH_C_OK");return 0;}\n' > hello.c
clang hello.c -o hello-c
printf 'int main(){return 0;}\n' > hello.cpp
clang++ hello.cpp -o hello-cpp
/system/bin/sh "$PREFIX/libexec/dsh-mobile/android-exec.sh" "$PWD/hello-c"
/system/bin/sh "$PREFIX/libexec/dsh-mobile/android-exec.sh" "$PWD/hello-cpp"
~~~

Do not copy Android system libc++ into the package. Headers, Android NDK sysroot and linker dependencies must match the Termux compiler.

## Python and pip

Determine whether the failure involves the pip executable/shebang, virtual environments, DNS/TLS, native wheel incompatibility, or an explicit policy:

~~~sh
python3 --version
python3 -m pip --version
python3 -m venv --help
python3 -m pip config debug
~~~

Prefer a user-owned virtual environment:

~~~sh
python3 -m venv "$HOME/.venvs/project"
"$HOME/.venvs/project/bin/python" -m pip --version
~~~

If the distro does not provide ensurepip, use the supported Termux python-pip package; do not force an externally managed installation using --break-system-packages. Network policy blocks require an approved index or authorized offline wheels. Python native packages need Android/bionic aarch64 compatible binaries; manylinux x86_64 wheels cannot be imported natively on Android.

## QEMU x86_64 user-mode

The included qemu-x86_64 is for **Linux x86_64 user-mode** executables. A program may require a trusted x86_64 Linux glibc/sysroot and QEMU's -L option to locate guest libraries. No x86_64 glibc is bundled automatically. It does not execute Windows DLLs or guarantee compatibility with host-specific syscalls and drivers. Full qemu-system-x86_64 virtualization is a different product, not installed by this workflow; hardware KVM for x86 guests is not available on a normal ARM Android device.

## CAP_NET_RAW

CAP_NET_RAW is a kernel capability, not a missing APK tool. Ordinary Android app UIDs usually lack it. Installing clang, QEMU, nmap or tcpdump does not grant privilege. Check /proc/self/status CapEff bit 13. Use unprivileged TCP/UDP/HTTP probes when possible; for authorized packet capture without root use user-approved Android VPNService capture, or obtain privileges through legitimate device management. DSH does not patch SELinux, fake capabilities or provide stealth/EDR-evasion functions.

## Acceptance criteria

Archive tests verify tool executable paths, package index SHA-256, AArch64 ELF, SDK resources and launcher aliases. Real Android testing must still confirm C/C++ compile/link, pip environment behavior, guest QEMU ELF execution, and runtime SELinux restrictions. The dev_environment_doctor diagnostic is read-only and cannot grant permissions or bypass organizational restrictions.
