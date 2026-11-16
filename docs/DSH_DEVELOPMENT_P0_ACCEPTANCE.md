# DSH Development Engine — P0 implementation and acceptance

## P0 scope

The development stack uses a single argv-only process runner:
- `dsh-dev-process.mjs` resolves embedded Android commands to app-private Termux entrypoints, routes them through `/system/bin/sh` plus the existing `android-exec.sh` linker bridge, and invokes `dsh-bounded-spawn.mjs`.
- `dsh-bounded-spawn.mjs` bounds time/output, supports AbortSignal cancellation, and kills the dedicated POSIX process group instead of relying exclusively on the direct PID. A child intentionally moving to a different process group cannot be forcibly controlled.
- Code Engine V3/V4, Basic Toolbox, Mobile Toolbox and Developer Task MCP entrypoints share this execution path. TypeScript source checks use the bundled tsc.js via the embedded Node binary rather than requiring a global tsc.
- `dev_task_start/status/cancel/list` supports bounded command execution, persistent task metadata in the user's DSH HOME, and explicit `interrupted` status after process restart. Task execution does not persist after the MCP server terminates; an interrupted task must be rerun.
- `dev_toolchain_smoke` creates a disposable C/C++ project, invokes Clang/Clang++, runs both generated Android ELF binaries through the linker bridge, and probes Python pip. It optionally creates a disposable Python virtual environment. The disposable directory is removed afterward.

## CI acceptance

The following must succeed in GitHub Actions on the exact source commit:

```sh
node scripts/test-dsh-bounded-spawn.mjs
node scripts/test-dsh-dev-process.mjs
node scripts/test-dsh-dev-tasks.mjs
node scripts/test-code-engine-v3.mjs
node scripts/test-code-engine-v4.mjs
node scripts/test-code-engine-workflow.mjs
node scripts/test-mobile-database-contract.mjs
node scripts/test-android-mcp-wire.mjs <staged-usr-directory>
python3 scripts/test-android-compiler-qemu-runtime.py
python3 scripts/test-ci-termux-abi.py
```

Android Gradle build plus ARM64 native packaging must succeed. Build presence alone is not a substitute for device run verification.

## Real Android acceptance

Install the signed APK as an **upgrade**, preserving package signature, app HOME, plugins, sessions, credentials and user workspaces. Do not uninstall or clear app data.

On the device, inspect these MCP results:

1. `dev_environment_doctor` — checks compiler, QEMU, Python and CAP_NET_RAW visibility.
2. `dev_toolchain_smoke` with `{"pythonVenv":true}` — validates real C/C++ compilation, linking, dynamic ELF execution, pip and optional venv.
3. `dev_task_start` with a known project test command, then `dev_task_status`, `dev_task_list` and `dev_task_cancel`. Verify cancel does not leave an active compiler process group.
4. `code_check` for JavaScript and TypeScript test sources, `code_test` for a real toolchain command.
5. `cmake_build` on a simple Android/aarch64 test project.
6. `apt_doctor` and `runtime_doctor` to distinguish missing dependencies, SELinux noexec, unavailable network and wrong ABI.

Completion on Linux CI **does not** prove these device operations succeed. Record stdout, stderr and exit codes when reporting real-device acceptance.

## Exclusions

Multi-language semantic project indexing, LSP, workspace orchestration and automatic code refactoring are P1–P3. CAP_NET_RAW cannot be granted by an unprivileged application. Neither this implementation nor QEMU adds Windows DLL execution, a privileged kernel environment or bypasses any external security controls.
