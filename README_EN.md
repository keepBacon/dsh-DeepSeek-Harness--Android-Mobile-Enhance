# DeepSeek Harness Mobile Enhance

[中文](README.md)

An enhanced and refactored **Android / Mobile client for DeepSeek Harness**, based on [dsh-mobile](https://github.com/thness/dsh-mobile) and [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness). The project focuses on workspace file management, plugin installation, UI switching, Android/Termux compatibility, stability, and mobile performance.

> Current version: **V0.1**  
> Android: `minSdk 26` / `targetSdk 34` / `compileSdk 36`  
> Primary architecture: `arm64`

## Features

- Run DeepSeek Harness directly on Android without a persistent desktop service
- Import local **files, multiple files, and folders** into the workspace
- Install, enable, disable, uninstall, and manage plugins
- Switch between the **mobile UI and native DSH UI**
- Workspace, Terminal, Git / SSH, and file search support
- Improved Android / Termux compatibility for Node, `node-pty`, Koffi, Sharp, ripgrep, and related runtime components
- Startup, file-processing, error-recovery, and runtime-diagnostics improvements

## Build

Use the project build script in Termux:

```bash
bash build-termux.sh
```

Default APK output:

```text
app/build/outputs/apk/debug/app-debug.apk
```

The build script prepares and validates DSH, Node, pnpm, npm, ripgrep, Git / SSH, native Node modules, and Android compatibility patches.

## Goal

Extend the core DeepSeek Harness experience with a more complete Android environment:

```text
Workspace + File Management + Plugin System + UI Switching
+ Android Compatibility + Stability + Performance
```

The goal is a maintainable and extensible Android Harness client suitable for long-term development.

## Upstream Projects

- [thness/dsh-mobile](https://github.com/thness/dsh-mobile)
- [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)

## License

This project is licensed under the [MIT License](LICENSE). Third-party components remain subject to their respective licenses and copyright notices.
