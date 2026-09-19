# Android ↔ Desktop capability mapping

| Desktop / Web capability | Android v0.11.1 implementation |
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
