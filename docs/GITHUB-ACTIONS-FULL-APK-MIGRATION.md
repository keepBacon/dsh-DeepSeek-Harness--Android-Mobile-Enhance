# GitHub Actions two-round full APK migration

Round 1: validate a complete **prebuilt Android/Termux** runtime snapshot using `scripts/ci-validate-runtime.py`; reject placeholder, incomplete tool bundles, wrong DSH family, wrong Node ABI and invalid archive paths. Kotlin/Gradle can take an upgraded versionCode while preserving Termux's default.

Round 2: manually run `Build complete Android APK (same-signature gate)`. Supply the **exact previously installed APK** and a tested runtime APK from repository Releases. The historical Release "1" is merely the default input, not proof that it matches the phone. The runtime APK must carry `assets/snapshot.tar.xz` and the source's locked DSH version.

**Required GitHub Actions secret:** `DSH_LEGACY_DEBUG_KEYSTORE_B64` must contain the base64 representation of the ORIGINAL `~/.android/debug.keystore` from the same Termux build host used to sign the user's currently installed APK. Debug keys vary by machine. Do NOT commit the key or create a new one; the workflow checks its SHA256 certificate against the baseline APK before building and fails on mismatch.

The workflow verifies package `com.dshmobile.shell`, a strictly higher `versionCode`, the exact signer certificate, snapshot SHA256 in the final APK and a matching runtime-version marker. It publishes an APK Artifact only after all checks pass.

**Limitations:** GitHub-hosted Ubuntu repackages a proven Android runtime and builds Kotlin/Gradle; it does **not** compile the entire Termux Node/Koffi/node-pty native tree on Ubuntu. To regenerate a newer DSH runtime, first supply an Android/Termux-produced snapshot. Archive validation is not a substitute for ARM64 runtime execution or on-device migration acceptance.

For the first install test, back up `Documents/dshdata` and app-private HOME, do not uninstall or clear app data, and verify existing sessions, MCP, database, Web Host and plugin profiles after installing in place. Signature and version checks protect Android's upgrade identity but cannot restore already missing conversations.
