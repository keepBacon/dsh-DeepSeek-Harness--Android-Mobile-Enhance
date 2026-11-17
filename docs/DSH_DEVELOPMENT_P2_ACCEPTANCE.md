# DSH Development Engine — P2 engineering workflows

## Delivered interfaces

P2 builds upon the existing P0 Android argv-only process runner and P1 workspace index, while retaining the original Code Engine edit journal and rollback path.

| MCP tool | Description |
|---|---|
| `workspace_refactor` | Dry-run or execute a bounded batch of regular-file creations, moves and deletions within the selected project. Existing file content editing continues through `code_edit_verify`. |
| `workspace_refactor_recover` | Examine and restore unfinished file-operation journals without overwriting conflicting external changes. |
| `workspace_detect` | Identify build systems from Gradle, CMake, npm, Python, Cargo, Go or Make manifests. |
| `workspace_build` | Run the selected build system on the P0 Android-aware process runner with bounded execution and compiler diagnostics. |
| `workspace_test` | Run the selected project test command and report failures. Python uses built-in `unittest discover` unless `pytest.ini` selects pytest. |
| `workspace_verify` | Sequential build and test; stop after first failing phase. |
| `workspace_edit_verify` | Apply existing-file edits through the durable Code Engine journal, run syntax checks (for JS) and project build/test before committing. Roll back edits on failures. |

### File transaction limits

- Up to 24 create/move/delete operations per batch, up to 8 MiB per changed file. Directories must already exist; directory-tree renames/deletes are intentionally excluded.
- Relative project-contained paths only. Traversal refuses symlink parents and symlink files. A file cannot occur twice in one transaction.
- Every batch supports dry-run and SHA-256 source preconditions.
- The journal lives under `$HOME/.dsh/workspace-refactor` (or the test-only `DSH_WORKSPACE_JOURNAL_DIR`); it stores original bytes before modifications.
- Application crashes leave pending journals, rather than silently discarding recovery metadata. A later invocation explicitly calls `workspace_refactor_recover` before another modification. Conflicting external modifications are reported, not overwritten.
- This is file-level recovery, **not a single atomically durable transaction across all filesystem operations**. Power failure/fsync durability and malicious concurrent writes still require device-specific validation.

### Build integration

- Executes via `dsh-dev-process.mjs` and the Android native linker bridge; no shell command concatenation.
- Detects Gradle wrapper vs installed Gradle, configures CMake before building, checks npm manifest scripts, and supports Python, Cargo, Go and Make when their compilers are present.
- Structured build errors include exit code, phase, bounded stdout/stderr, parsed file/line/column and next action. Compiler logs are not guaranteed to follow one standard format.
- Running an untrusted project's build script executes that project's code with the DSH app's privileges. Open trusted workspaces only.

### Workflow examples

Create and move source files:

```json
{"root":"/path/to/project","dryRun":true,"operations":[{"type":"create","path":"src/new.ts","content":"export const value = 1\n"},{"type":"move","path":"src/old.ts","to":"src/renamed.ts"}]}
```

Validate project changes before permanently committing:

```json
{"root":"/path/to/project","runTests":true,"edits":[{"path":"/path/to/project/src/main.py","oldText":"return 4","newText":"return 5"}]}
```

Use `workspace_edit_verify` for the second example. It preserves existing file data if build/test fails.

### Automated acceptance

```sh
node scripts/test-dsh-workspace-files.mjs
node scripts/test-dsh-project-build.mjs
node scripts/test-dsh-workspace-edit-verify.mjs
node scripts/test-code-engine-workflow.mjs
node scripts/test-android-mcp-wire.mjs <staged-usr>
```

GitHub preflight, Runtime Graph, ARM64 Runtime packing, Gradle compile, and the signed APK are distinct checks. Real-device filesystem lifecycle, Power-loss recovery and Gradle/CMake runs must be tested on Android before claiming physical-device acceptance.

### P2 scope boundary

P2 provides file-level project structural operations and rollback-verified source edits. It does **not** implement scope-aware AST renaming across all languages, automatic Gradle dependency-file editing, persistent build processes after MCP process exit, or P3's autonomous planning and multi-stage recovery agent. These remain explicit future work rather than being incorrectly claimed as completed.
