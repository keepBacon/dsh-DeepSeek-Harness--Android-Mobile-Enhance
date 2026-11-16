# DSH Android ARM64 — APT/libc++ dynamic linker repair

## Cause

The GitHub ARM64 builder unpacks a signed seed and overlays current SHA-256-verified Termux packages. Previously **any existing path** was kept; the seed could retain an older `libc++_shared.so` or `libapt*.so` while the overlay brought newer native dependencies. This produces `CANNOT LINK EXECUTABLE` or `cannot locate symbol` errors even when the packages were downloaded correctly.

## Repair in the build

- Resolve `apt` and `libc++` (and their recursive `Depends`/`Pre-Depends`) against **one** Termux aarch64 package index.
- Replace only ELF files and SONAME links from that package cohort, leaving the DSH/Node/runtime scripts and non-native user configuration alone.
- Verify staged `usr/lib/libc++_shared.so` SHA-256 against the `libc++` deb; inspect AArch64 ELF and `DT_NEEDED` references for APT binaries and `libapt` libraries.
- Archive assembly and the Android extraction mechanism do not overwrite `HOME`, sessions, workspaces, user profiles, credentials or `Documents/dshdata`.

## Device verification (required; not established by GitHub Actions)

After installing the new **signed upgrade APK** over the existing DSH app, open its terminal. Execute in this order:

```sh
apt --version
apt-get --version
apt-cache policy apt libc++
dpkg-query -W -f='${Package} ${Version} ${Status}\n' apt libc++
pkg list-installed
```

Successful `--version` commands establish that the native linker can start those executables. `apt-cache policy` verifies APT can load its configuration and package interfaces. The dpkg status can initially report older package versions if those were inherited from the signed seed; it is not an ELF loader validation.

Once those read-only checks pass and network access is available:

```sh
apt update
```

Record the **exit code and complete stderr** (redact private paths or credentials) if anything fails. In particular, distinguish `cannot locate symbol`, missing `libapt`/C++ SONAME, permission/noexec, missing PRoot prefix, and network/source errors.

Do not copy an arbitrary system `libc++.so` into the runtime, force `LD_LIBRARY_PATH` to another app's prefix, disable linker/SELinux checks, clear the DSH application data, or reinstall all packages blindly. Diagnose the exact failing SONAME/symbol first.

## Test references

```sh
python3 scripts/test-ci-termux-abi.py
```

GitHub Actions validates the native archive with `scripts/ci_termux_abi.py` and `scripts/ci-validate-runtime.py`. A Linux ARM64 runner cannot reproduce the Android dynamic linker, app-UID restrictions or actual package installation; device results remain authoritative.
