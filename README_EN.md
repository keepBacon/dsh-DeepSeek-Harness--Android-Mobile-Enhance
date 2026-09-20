# DeepSeek Harness Mobile V0.1

> **DeepSeek Harness Mobile Enhance is an Android-focused DeepSeek Harness distribution with enhanced workspace import, plugin installation, UI switching, Android/Termux compatibility, stability, and mobile usability.**

[中文](README.md)

DeepSeek Harness Mobile is a standalone Android shell for DeepSeek Harness. It starts a local DSH Host on the device and provides a mobile interface through a restricted Android WebView while preserving workspace, plugin, terminal, Git/SSH, and file-search capabilities.

> App version: **V0.1**  
> Default DSH: `@deepseek-ai/dsh 0.1.5-rc.2`  
> Android: `minSdk 26` / `targetSdk 34` / `compileSdk 36`  
> Primary architecture: `arm64`

## Features

- Run DeepSeek Harness locally on Android without a permanently running desktop service.
- Switch between the mobile-oriented layout and the native DSH layout.
- Manage workspace directories, file imports, attachments, and session exports.
- Import local single files, multiple files, and complete folders into the current workspace while preserving directory structure.
- Install plugins from npm, GitHub, Git, SSH, local ZIP files, and tarballs.
- Manage plugin installation, enable/disable state, removal, compatibility checks, and plugin error logs.
- Bundle or integrate pnpm, npm/npx, ripgrep, Git, OpenSSH, CA certificates, and other runtime components.
- Apply Android/Termux compatibility handling for `node-pty`, Koffi, Sharp, ripgrep resolver behavior, dynamic library loading, W^X restrictions, and related runtime issues.
- Provide a GitHub repository entry in Settings.
- Provide diagnostics and repair paths for missing or damaged runtime components.
- Continue improving responsive behavior for phones, landscape mode, and tablets.

## Workspace and File Import

The file-import layer is designed for modern Android storage behavior, with priority support for Storage Access Framework, `content://` URIs, and Scoped Storage.

Supported directions include:

- Single-file import
- Multi-file import
- Recursive folder import
- Directory-structure preservation
- Duplicate-name handling
- Asynchronous large-file copying
- Automatic workspace refresh after import

File and directory access should be centralized in workspace/storage layers instead of coupling UI code directly to absolute filesystem paths.

## Plugin System

The plugin system is designed to make DeepSeek Harness extensions manageable directly from Android.

Planned and supported installation paths include:

- Local ZIP / tarball
- Local plugin directory
- npm source
- GitHub / Git repository
- Version validation
- Harness compatibility validation
- Enable / disable
- Uninstall
- Plugin error logging

Plugin extraction and installation should include path-safety validation to prevent traversal, unsafe overwrites, and unbounded extraction.

A faulty third-party plugin should be isolated as much as possible so that one plugin does not terminate the entire application.

## UI and Layout Switching

The project provides switching between a mobile-oriented interface and the native DSH layout, with room for additional interface profiles.

UI switching should preserve as much active state as possible:

- Current workspace
- Open content
- Terminal session
- Current page state
- Harness/Host process continuity

UI priorities are:

```text
Function
>
Hierarchy
>
Feedback
>
Motion
>
Decoration
```

The interface should avoid excessive gradients, glow, glass effects, heavy shadows, or decorative animation that does not improve usability.

## Android Storage Compatibility

Android storage behavior differs significantly between OS generations, so the project prioritizes modern storage APIs.

Key areas include:

- Android 8+
- Storage Access Framework
- Scoped Storage
- `ACTION_OPEN_DOCUMENT`
- `ACTION_OPEN_DOCUMENT_TREE`
- `ContentResolver`
- `content://` URI support

The application must not assume that a selected file can always be represented as a traditional path such as:

```text
/storage/emulated/0/...
```

## GitHub

Repository:

https://github.com/keepBacon/dsh-DeepSeek-Harness--Android-Mobile-Enhance

Inside the app, it can be opened through:

**Top Settings → App Settings → GitHub Repository**

## Building with Termux

Install dependencies:

```bash
pkg update -y
pkg install openjdk-17 nodejs-lts clang cmake ninja make python binutils pkg-config \
  libandroid-spawn ripgrep git openssh ca-certificates \
  curl unzip tar xz-utils aapt2 -y
```

After extracting the source:

```bash
cd /storage/emulated/0/Download
unzip dsh-mobile-v0.1-source.zip
cd dsh-mobile-v0.1
bash build-termux.sh
```

APK output:

```text
app/build/outputs/apk/debug/app-debug.apk
```

`build-termux.sh` is more than a Gradle wrapper. It also prepares and validates the Android runtime, including DSH, Node.js, pnpm, npm, ripgrep, Git/SSH, native Node modules, and compatibility patches.

Unless a complete and compatible `snapshot.tar.xz` has already been prepared, directly running only `./gradlew assembleDebug` is not recommended.

## Runtime Snapshot

The runtime snapshot is located at:

```text
app/src/main/assets/snapshot.tar.xz
```

It must be prepared specifically for Android/Termux and processed with the compatibility logic used by this project. A normal Linux root filesystem cannot be substituted directly.

The build scripts validate at least these critical components:

```text
usr/bin/node
usr/lib/node_modules/@deepseek-ai/dsh/lib/bin.js
usr/lib/libtermux-exec-ld-preload.so
```

V0.1 also preserves safe compatibility for the valid Android system-shell symlink:

```text
usr/bin/bash -> /system/bin/sh
```

Other absolute links or archive paths that may escape the extraction root remain rejected.

## Shell / Terminal Compatibility

Mobile shell environments differ substantially from conventional desktop Linux.

The project handles or validates:

- Shell path
- PATH
- HOME
- TMPDIR
- LANG
- Working directory
- Executable permissions
- Android/Termux dynamic-library paths

The runtime should not assume that `/bin/bash` exists. Available shells must be detected from the actual device environment.

## External Tool Compatibility

Availability should be checked before depending on:

- Git
- Node.js
- npm / npx
- pnpm
- Python
- ripgrep
- OpenSSH
- tar
- unzip

Missing tools should produce explicit diagnostics instead of causing an opaque failure halfway through an operation.

## WebView Compatibility

When Harness pages are hosted inside Android WebView, the project focuses on:

- Android System WebView version differences
- JS Bridge failures
- Page-load failures
- WebView crash recovery
- File uploads
- External URL handling
- Cookies and caching
- Local Host privilege boundaries

Privileged Android bridges should only be exposed to trusted local Host content.

## Error Handling and Logging

The project aims to centralize error categories and diagnostics across:

- Workspace
- Plugins
- Terminal
- API
- UI
- Processes
- Storage
- Network
- Git

The UI should present actionable error messages while retaining detailed logs for debugging.

Instead of only showing:

```text
Network Error
```

the application should distinguish conditions such as:

- Connection timeout
- DNS failure
- Permission denial
- Inaccessible target file
- Plugin version mismatch
- Missing external tool
- Damaged runtime component

## Performance

Primary optimization areas include:

- Cold-start time
- Workspace scanning
- Large-directory loading
- Large-file copying
- Heavy terminal output
- Plugin loading
- WebView initialization
- UI redraw cost
- Background task scheduling
- Memory usage

File copying, extraction, Git operations, plugin installation, and directory scanning should be moved off the Android UI thread whenever possible.

Large directory trees should prefer lazy loading and incremental refresh instead of repeatedly rescanning the entire workspace.

## Memory and Large Files

For large files and long-running sessions:

- Avoid loading entire large files into memory at once
- Use streaming I/O and buffered copying
- Bound terminal history growth
- Close streams promptly
- Prevent WebView and Activity Context leaks
- Avoid retaining unnecessary large objects

## Compatibility Targets

Primary targets:

```text
Android 8–15+
arm64-v8a
armeabi-v7a (when runtime dependencies support it)
x86_64 (when runtime dependencies support it)
```

If an ABI or runtime component is unavailable, the application should report the incompatibility before execution instead of failing with a low-level crash such as `UnsatisfiedLinkError`.

## Upstream Open-Source Projects

This project is based primarily on:

| Project | Purpose | Upstream |
| --- | --- | --- |
| dsh-mobile | Android mobile implementation base and runtime integration reference | https://github.com/thness/dsh-mobile |
| DeepSeek Harness | Core Harness, Web UI, and plugin system | https://github.com/deepseek-ai/deepseek-harness |

Both upstream repositories currently use the MIT License. Other third-party components included in build outputs remain subject to their own licenses and copyright notices.

## Security Design

- The privileged Android WebView bridge validates calls with a capability generated for each Activity lifecycle.
- Only trusted local DSH Host content may access high-privilege bridge functions; external URLs are opened in the system browser.
- Plugin ZIP extraction enforces path-traversal, file-count, directory-depth, per-file-size, and total-size limits.
- SSH private keys and private Git HTTPS tokens are protected through Android Keystore.
- Runtime TAR extraction checks for path escape and only permits whitelisted Android system links where required.
- Third-party plugin build scripts are not executed unconditionally; pnpm 11 build approval remains explicit.

## Project Structure

```text
app/                    Android application
app/src/main/assets/    Runtime snapshot and version metadata
scripts/                Android runtime patches / regression checks
build-termux.sh         Complete Termux build entry point
build-offline-termux.sh Offline build entry point
CHANGELOG.md            Change history
LICENSE                 Project license
README.md               Chinese documentation
README_EN.md            English documentation
```

## Project Goal

This project is not intended to be only a collection of extra buttons on top of DeepSeek Harness Mobile. The long-term goal is to provide a more complete, stable, and maintainable Android Harness environment:

```text
DeepSeek Harness
+
Android Native Host
+
Workspace
+
File / Folder Import
+
Plugin System
+
UI Switching
+
Terminal
+
Git / SSH
+
Compatibility Improvements
+
Stability and Performance Work
```

The objective is to preserve upstream capabilities while making DeepSeek Harness more practical, stable, and extensible on Android and Termux.

## License

This project's source code is distributed under the [MIT License](LICENSE).

Third-party dependencies retain their own licenses and copyright notices. This project's MIT License does not replace or alter the licensing conditions of third-party components.
