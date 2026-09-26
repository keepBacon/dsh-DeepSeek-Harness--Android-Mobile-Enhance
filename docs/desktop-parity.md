# Android ↔ Desktop capability mapping

| Desktop / Web capability | Android V0.1.1 implementation |
|---|---|
| Full DSH Web UI | Same upstream Web UI; desktop UA + 1280px viewport |
| Current Desktop/Web DSH family | `build-parity-termux.sh` refreshes to pinned `@deepseek-ai/dsh` |
| Local Host | Embedded Node + DSH on `127.0.0.1:3080` |
| Bundled package manager | pnpm 11.7.0 injected into runtime with Android wrapper |
| Plugin Manager | Upstream Web manager when present + native fallback |
| Install/update/remove | `dsh plugin --profile web ...` |
| Enable/disable bundle | Profile bundle selection + Host restart |
| Local package import | SAF → private real path → DSH package operation |
| Native directory picker | SAF + primary/removable volume mapping |
| Open config file | Built-in `cordis.patch.yml` editor |
| Config safety | `.bak-last` + `--dump-config` validation + rollback |
| External links | Android `ACTION_VIEW`, including `target=_blank` |
| JS dialogs | Native Android alert / confirm / prompt |
| Browser uploads | `onShowFileChooser` + multi-document picker |
| Downloads | Same-origin HTTP → streamed MediaStore Downloads |
| Android Back | Escape overlays first, then browser history |
| Startup recovery | Runtime repair / disable third-party bundles / patch backup-reset |
| Background Host | Foreground service + watchdog |
| Explicit Host stop | Notification action |
| System theme | WebView dark-mode bridge |
| Desktop-sized UI | desktop UA + desktop viewport + pinch zoom |
| Web diagnostics | console → logcat; runtime / engine log copy action |

OS-specific Electron window chrome, Windows/macOS installer/update signing, and the PC-only Python/Office primary runtime are not mapped 1:1.


## Desktop Web capability contract

Android does not maintain a reduced parallel DSH backend. The packaged runtime boots the same upstream Web profile and adapts only OS-specific seams.

The build now runs `dsh web --dump-default-config` against the staged Android runtime and validates the resulting composition before the APK is packaged. The contract requires the desktop Web surfaces for Workspace/Workspace Files, plugin inventory/settings, Jobs, Skills, Subagents, Workflow, filesystem/Web tools, attachments, TypeScript Code Runtime, and their Host/API/UI bridges to remain present.

The validator also preserves upstream semantics instead of force-enabling rows: Web model-facing `tool-*` rows remain host-disabled because `dsh-agent-presets` composes them per Agent; PowerShell remains Windows-only; Schedule remains opt-in. A missing or unexpectedly disabled core capability fails the build.
