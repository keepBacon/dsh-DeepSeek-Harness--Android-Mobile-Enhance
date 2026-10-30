# GitHub Actions: original DSH APK signing key

The **installed Android app** and original keystore have the same certificate
SHA256: `0dfb924793215056c19d413987c9858b8aa9d90604ffb18d60cfd75be0697792`.

The GitHub Secret `DSH_LEGACY_DEBUG_KEYSTORE_B64` must contain **only the
complete Base64 text** of the existing `~/.android/debug.keystore` file. It
must not contain shell command text, a filename, quotation marks or a copied
terminal prompt. Whitespace/newlines are accepted, but missing bytes are not.

On the original device, use the existing Termux installation **only to read
the already-existing key, not to build the APK**:

```sh
# Verify that the original key file exists (do not regenerate it):
test -s "$HOME/.android/debug.keystore"
# Check the expected length without displaying private bytes:
base64 -w 0 "$HOME/.android/debug.keystore" | wc -c
# To copy the complete Base64 text, use:
base64 -w 0 "$HOME/.android/debug.keystore"
```

Paste the entire output into GitHub → repository Settings → Secrets and
variables → Actions → `DSH_LEGACY_DEBUG_KEYSTORE_B64` → **Update**.

The independent `signing-key-preflight` job checks correct Base64 decoding,
keystore format/alias and certificate fingerprint **before** the expensive
native runtime job. Failed checks stop the pipeline without publishing an APK.
No private key is printed or committed.

GitHub-native runtime assembly currently reuses an existing Android Node/DSH
baseline and supplements it with SHA256-verified Android package binaries and
source modules. Passing archive validation is not yet proof that all Android
native modules can load or that the updated DSH preserves on-device sessions.
Do not uninstall/clear app data; back up Documents/dshdata before any in-place
installation and run a true device acceptance test.
