# Android plugin UX migration — DSH 0.2.2

## Ownership

The Android shell does not implement a separate plugin inventory, installer,
enable/disable view, or plugin settings form. All plugin UI, including
configuration and account/provider settings, belongs to upstream DSH's
standalone **Plugins** global panel.

Android's settings button and the "Settings > Built-in plugins" shortcut
only navigate to that panel. The Settings built-in plugin section is
inventory-only; it is not the provider account management form. If the
upstream global panel is unavailable, display a visible readiness error
rather than switching to an Android-specific plugin manager.

Keep Android bridge functionality limited to device/host integration:
Termux binaries, Android linker-safe subprocess spawning, Git/SSH,
certificate stores, lifecycle script shell, pnpm workspace policy,
credential handling, profile preservation, diagnostics, and safe boot
recovery. Do not route new plugin installation through obsolete Android
archive extraction or duplicate its UI.

## Third-party Web clients

A bundle must be installed in the active DSH Web profile and successfully
declare a Cordis bundle patch and a Web client. Check published
`package.json` fields before attributing a blank plugin page to Android:

- `dsh.bundle.patch` resolves to a real packaged file.
- `dsh.client.platform` is `web`.
- `exports["./client"]` resolves to a packaged JS file (direct string,
  conditional `import`, or `default` export).
- The host `main` entry exists when declared.
- Every `@deepseek-ai/*` dependency in `dsh.client.inject` is present
  in the embedded DSH release family.

Two priority integrations are `dsh-zcode-startplan` (published root
`client.js`) and `dsh-providers-hub` (published
`lib/client/jet-hub.js`). The latter's Git source form runs a
`prepare` script to produce `lib` assets. A source install
without those assets cannot be fixed by changing WebView CSS.

## Installation and credentials

Use DSH's upstream package manager and plugin manager UI. Android Host
prepares `npm_config_script_shell=/system/bin/sh`, the Git spawn bridge,
CA chain, and `autoInstallPeers=false` to avoid retrieving unsupported
DSH prerelease peer packages. Do not silently authorize untrusted lifecycle
scripts. An interrupted/blocked source build must have an actionable
failure and must not be mistaken for an empty plugin page.

Never modify account pools, OAuth state, user-installed plugin source, or
credentials while diagnosing client bundles. Keep the existing app ID,
home/profile directories, sessions and signing identity across upgrades.

## Acceptance matrix

1. DSH 0.2.2 release-family and client UI plugin-manager artifacts are
   bundled and version-matched.
2. Both Android entry points navigate to **DSH Plugins**, not an Android
   tools or legacy package-manager UI.
3. Test source checks in `scripts/test-android-settings-four-seat.mjs` pass.
4. Installing ZCode via the official page registers its host bundle and
   Web client; account and model settings render and persist after restart.
5. Installing Providers Hub via published package and Git source (with
   explicitly approved `prepare`) both produce a real client JS asset;
   account pool/credential UI renders and persists.
6. Failure cases (missing client export, client bundle absent, missing
   injected package, blocked scripts, Git spawn failure) report a bounded,
   actionable diagnostic rather than changing profile data silently.
7. Signed ARM64 APK is built; Android app-UID startup, navigation, provider
   authentication, and data-preserving upgrade are tested on a device.

Source checks and GitHub CI do **not** constitute physical Android or
provider-login acceptance. Do not merge a release with failed checks.

## Model discovery and modal layering (DSH 0.2.2-rc.5)

Upstream `ModelListEditor` opens a second body-portaled `Modal` for
**Fetch available models** (and other nested confirmations). The upstream
`ui-primitives` modal root uses `z-index: 1000`; Android must not assign
an excessively high z-index to the Settings overlay. The Android shell chrome
is below Settings, and Settings is below secondary upstream dialogs. The same
layering applies to provider credentials and plugin-owned dialogs. The fix
preserves the upstream React events, network discovery RPC and form state.

A disabled Fetch button may instead mean that the form lacks a URL, protocol,
or required API key. Upstream signals that in the button's `disabled` and
`title` attributes; do not simulate requests or bypass validation.

Test: `node scripts/test-android-settings-four-seat.mjs` checks stacking
order, Settings navigation and source-level form preservation.
