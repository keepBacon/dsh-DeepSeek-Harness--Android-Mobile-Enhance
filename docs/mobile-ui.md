# Mobile UI architecture

The Android shell keeps the upstream DSH application and Host intact. `MainActivity.installMobileUiBridge()` adds a thin presentation layer after each Web document load.

The bridge uses stable semantic surfaces where possible (`data-rightbar-col`, `data-conversation-content`, `data-conversation-scroll`, `data-composer-seat`, ARIA labels) and tags the relevant AppFrame nodes with `data-dsh-mobile-*` attributes. CSS then changes only layout behavior:

- AppFrame: `0 / 1fr / 0` grid on phones.
- Sidebar: fixed left drawer, not a permanent desktop column.
- Center: full viewport width below the mobile top bar.
- Rightbar: bottom sheet.
- Settings: full-screen modal with horizontally scrolling navigation.
- Composer: single-column, safe-area aware.

No Host APIs or plugin contracts are replaced. The Android-only controls proxy existing DSH actions by clicking the upstream semantic buttons or invoking `androidBridge` for native-only operations such as importing phone files.

## v0.11.4 修正

- Workspace 文件导入入口固定到 Composer 工具行，不再放在顶部 App Bar 或 Workspace Picker 旁边。
- Settings DOM 适配使用官方 `SettingsRoot` 的真实结构：`dialog > nav + content`。
- 设置导航在手机端变成横向 Tab；内容列独立滚动，避免桌面 `188px` nav rail 挤压正文。
- 设置中的表单、媒体、代码块遵循手机宽度；长内容由 options 区域滚动而不是让整个 dialog 失控。
