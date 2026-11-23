# DSH Cloud Analysis inputs

This directory is the **only** input source for the `dsh-cloud-analysis.yml`
workflow. The workflow refuses external URLs, shell commands, path traversal
and files outside `cloud-inputs/`.

**Do not commit private APKs, credentials, licensed software, customer binaries
or other sensitive material to a public repository.** For confidential analysis,
use a **private** repository/workflow or a separate authenticated sandbox.

To run: add a file you are authorized to inspect under `cloud-inputs/`, then
use the official GitHub Actions remote MCP toolset in DSH to trigger workflow
`dsh-cloud-analysis.yml` with inputs:

- `task`: `jadx`, `ghidra`, `linux-x64` or `windows-pe`.
- `input_path`: repository-relative path, for example `cloud-inputs/sample.apk`.

The resulting logs/reports are uploaded as workflow artifacts with a 7-day
retention period. The Windows runner **does not execute** user-supplied EXEs,
it only inspects them. On-demand Ghidra/JADX downloads have pinned SHA-256
checks. DSH Android never starts a JVM, x86 emulator or Windows runtime.

GitHub Actions may incur usage charges depending on the repository and plan.
