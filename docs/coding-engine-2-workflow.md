# Coding Engine 2.0 — Android Deep Engineering workflow

> Status: experimental implementation on a feature branch. Not a replacement for official DSH Agent, Subagent, Workflow, or core tools.

## Activation and boundaries

Navigate to **应用设置 → 安卓扩展管理** and enable **mobile_tools**, **Coding Engine 2.0**, and, if required, **子代理协同任务板**. Changes require the DSH Host restart. Tool latency telemetry is **off by default** and can be independently enabled as **工具耗时诊断**.

All Coding Engine tools remain hidden when Coding Engine is disabled. Closing the coordination switch does not disable DSH's native Subagent API. The new adapter accepts the existing board's advisory `agentId`, but **does not spawn children, cryptographically authenticate agents, or replace the DSH native tool lifecycle**.

## Recommended task flow

1. Use `codebase_map`, `code_index_refresh` and `code_index_query` to identify a bounded change surface. Source indexing is heuristic; validate declarations against the real compiler when accuracy matters.
2. Define dependencies and separated write scopes with `coordination_create`. Native DSH Subagent handles actual spawn and communications.
3. Each participating subagent calls `coordination_claim`; keep its board ID, task ID, owner and latest revision. A heartbeat increments the revision, so **always reuse the newest revision returned by the API**.
4. Preview an edit with `code_transaction_apply` or the legacy `code_edit_transaction` (both default to dry-run); require exact SHA-256 hashes for every changed file. Use `dryRun:false` only for the explicitly approved edit.
5. If the operation reports `CODING_TX_RECOVERY_REQUIRED` or `needs_review`, inspect `code_transaction_status` and use `code_transaction_recover`. Never overwrite externally modified files merely to clear a warning.
6. Call `code_test_select` and `code_verify_recipes` to inspect candidates; execute an explicit, allowlisted recipe with `code_verify` or `code_verify_batch` (`dryRun:false`).
7. For linked agent completion, call `code_task_verify` with an active owned task, current revision, nonempty tracked source paths, 1–4 verification recipes and `dryRun:false`. **Only `finalize:true` with a nonempty summary marks the task complete after all recipes succeed, tracked file hashes remain unchanged and no unresolved transaction is present.**
8. A failing test does not complete the task. Inspect returned diagnostics and repeat with the updated task revision. The adapter renews the task lease before running tests.
9. Review the overall board using `coordination_status`. Do not call the project done until unit tests, Android Gradle CI, Termux build, and required device checks are reported separately.


## P0 engineering analysis (experimental)

Eight opt-in read-only tools are exposed by mobile_tools when Coding Engine 2.0 is enabled:
`code_semantic_index`, `code_symbol_references`, `code_dependency_graph`,
`code_call_graph`, `code_change_impact`, `code_root_cause`,
`code_patch_plan`, `code_test_impact`.

These tools share the existing incremental index. No model calls, mutation, test execution,
or LSP server are initiated by them. The index is heuristic, not compiler-resolved.
Symbols and references can match comments and string literals; relative import edges
are candidate file dependencies only. Call sites do not prove invocation edges.
Root-cause candidates do not prove causality, and the patch plan is advisory.

Validation: `node scripts/test-code-p0.mjs` checks all eight interfaces and
path traversal rejection. `scripts/check-remaining-fixes.sh` runs it in CI,
and `build-termux.sh` packages `dsh-code-p0.mjs` with a syntax check.
The complete Android rootfs build and device-side MCP calls require separate verification.

## Semantic hardening — first of two finalization rounds

`code_symbol_references` now accepts `backend: "python-ast"` to ask a
bounded Python AST helper for syntax-level definitions, loads, assignments,
attribute candidates and call candidates. The AST backend ignores comment and
string-literal mentions; it does not establish symbol binding across modules.
The existing heuristic backend remains the fallback for other languages.

The indexed-file reader revalidates path containment, file size, regular-file
status and symlink safety. AST subprocess work is bounded by input size,
execution time and result size, and is copied into the embedded Termux runtime.
Tests run from `scripts/test-code-p0.mjs`.

Tree-sitter grammars, language-server rename, cross-language binding analysis,
full performance benchmarks and Android device execution are not established
by this first-round change. They must be assessed separately in the next
round before describing the project as release-ready.

## P1 guarded engineering and coordination tools

Coding Engine P1 registers eight operations: `code_ast_edit` (real Python AST validation and
SHA-256 journaled replacement), `code_refactor` (read-only rename preview; applying a
cross-language refactor requires compiler/LSP and is rejected), `code_contract_check`
(candidate import-path problems), `code_patch_conflict`, `code_regression_bisect`
(read-only Git candidate selection), `code_failure_cluster`, `code_fix_verify`
(reuses the bounded repair cycle) and `code_checkpoint` (hash records, **not** restore backups).

Coordination P1 registers six operations: `agent_task_decompose`,
`agent_scope_allocate`, `agent_shared_context`, `agent_result_review`,
`agent_merge_guard`, `agent_failure_recovery`. These remain advisory and do not
spawn, authenticate or impersonate an actual DSH subagent. A merge guard
never merges code, and requires completed dependencies, no unresolved transaction,
and PASSED verification evidence from the task board. Review evidence is bounded
to 16 tracked files; untracked edits are not proven absent.

P1 tools are opt-in via Coding Engine/coordination switches. Python AST support
requires `python3` inside the embedded runtime. No promise of general-purpose
cross-language AST/LSP rename, whole-workspace atomicity or verified device behavior
is made. CI runs `node scripts/test-code-p1.mjs` plus the previous regression suite;
Android/Termux build and on-device tests remain independent gates.

## Final round: bounded Python cross-file rename and merge evidence

`code_refactor` accepts `originPath` and a list of 1–16 explicit Python
`paths`, then uses Python `ast` plus token positions to prepare a bounded
multi-file rename. It rejects ambiguous imports, shadowing/collisions and
module-qualified attribute access. Dry-run is the default. Committing requires
`dryRun:false` **and** `allowPartialScope:true` because the path set is
caller-supplied and can omit other project files. The edit reuses checked
SHA-256 transactions and rollback; it does **not** prove global name binding.
Other languages need a compiler/LSP backend and remain unsupported for writes.

`agent_merge_guard` now compares tracked file hashes with SHA-256 evidence
recorded by task verification (maximum four evidence-bound files). It only
advises manual merge; the cooperative task owner label is not an authenticated
identity, and the guard is not a substitute for human review or repository
branch protection.

CI runs regression tests but cannot verify Android hardware and local DSH
plugin execution. Do not merge or advertise production readiness until a
Termux package build and on-device MCP exercise are independently observed.

## MCP P0 governance (experimental)

The mobile MCP server now exposes `mcp_tool_search`, `mcp_registry_audit`,
`mcp_tool_probe` and `mcp_server_health`. Search is over the **currently visible**
runtime catalogue, not a stale static model prompt. Audit compares declared names
with this bundled server's dispatch cases. It does not inspect all third-party
Cordis plugin handlers or prove Android device functionality.

The call layer validates bounded JSON input against the advertised input
schema, rejects non-lossless structured outputs (including undefined, NaN,
non-finite numbers, BigInt, circular structures and excessive size), and
returns handler failures as MCP `isError` messages so one failed call does not
terminate the stdio server. Safe probing uses an explicit read-only allowlist;
arbitrary shell, network, database or plugin tools are never probed with real
side effects.

**Compatibility:** legacy SDK stdio remains the default. Experimental
`DSH_MCP_PROTOCOL_MODE=2026-07-28` enables a separate stateless stdio
adapter for `server/discover`, `tools/list` and `tools/call` with
per-request version metadata; this is NOT enabled for the legacy DSH client,
and it does not constitute complete 2026 extensions/Streamable HTTP support.
Existing Streamable HTTP connections remain managed by the Android Host.

**Child recovery:** an optional `dsh-mcp-supervisor.mjs` restarts crashed
stdio MCP children with bounded backoff. It reports in-flight requests as
failed, NEVER replays side-effectful calls, and restores the legacy
initialize handshake. Android's `mcp-servers.json` supports
`restartSupervisorEnabled:true` to use the wrapper for `mobile_tools`.
It is OFF by default until device interoperability is confirmed. This is not
remote HTTP reconnection, and it does not repair defective third-party
plugin Handlers.

Verification: `node scripts/test-mcp-governance.mjs`,
`node scripts/test-mcp-modern-stdio.mjs`, `node scripts/test-mcp-supervisor.mjs`
and `node scripts/test-tool-registry-parity.mjs` run in static CI.
Termux APK packaging and Android-side plugin Handler checks are separate gates.

## MCP P1 workflow orchestration

The MCP toolbox adds eight bounded tools: `mcp_workflow_plan`,
`mcp_workflow_execute`, `mcp_workflow_status`, `mcp_workflow_cancel`,
`mcp_checkpoint_restore`, `mcp_result_compact`,
`mcp_capability_report`, and `mcp_trace_analyze`. These complement
the four governance tools added in P0 (12 total).

Workflow plans are acyclic DAGs of at most 24 nodes; scheduler concurrency
is bounded at 1–4. Dependencies may bind values through
`{"$from":"node-id","path":["property"]}`. The engine stores JSON
snapshots with atomic rename and SHA-256 result fingerprints. A new tool call
starts an asynchronous workflow and returns its id. `status` provides
polling, and `trace` records bounded timings and event types only, without
raw args. Tools are exposed only if registered and in an audited allowlist.

Side effects are denied by default. Writes are limited to specific existing
coding transaction tools and require `allowSideEffects:true`, each node's
`effect:"write"`, and `args.dryRun:false`. Writes are serialized, and
are never automatically retried. A cancellation prevents new nodes but does
**not** forcibly terminate a running tool. After process termination,
`mcp_checkpoint_restore` defaults to read-only inspection; an explicit
`action:"resume"` continues only eligible pending read nodes. Interrupted
nodes are not replayed, and interrupted writes require human-led transaction
recovery. The engine cannot prove arbitrary tools are side-effect free; the
allowlist is intentionally conservative.

`mcp_result_compact` returns a bounded preview with the SHA-256 of the
original JSON, not a substitute for the original value. Result sizes and
persisted state are bounded to control Android resource usage.

**Validation:** `node scripts/test-mcp-workflow.mjs` tests DAG cycles,
dependencies, result references, persistence, error blocking, cancellation
and write permissions. The MCP coding dispatch smoke additionally invokes
the workflow tools end to end. These are source/runtime tests, **not**
device-side verification or a guarantee that a long-running workflow keeps
progressing after the Android process is killed.

## MCP P2 Resources, Prompts, Android context

Resources are exposed over legacy SDK and experimental 2026-07-28 stdio:
`resources/list`, `resources/templates/list`, `resources/read`,
`prompts/list` and `prompts/get`. The resource names are
`dsh://workspace/tree`, `dsh://android/capabilities`,
`dsh://android/build`; the URI template
`dsh://workspace/file/{path}` reads bounded UTF-8 sources with
`?startLine=1&maxLines=80`. Files are scoped to
`DSH_MCP_WORKSPACE_ROOT` (default process working directory), reject
path traversal, hidden segments, symlinks, binary content and large files.
An opt-in 3-second/16-entry in-process cache and SHA-256 source
fingerprints reduce repeated context extraction.

Five reusable prompts cover architecture review, root cause, safe patch,
Android build and plugin diagnosis. The `mcp_context_budget` tool extracts
bounded matching source lines without generating new claims. Existing
`android_logcat` already accepts `sinceSeconds`; existing
`apk_inspect` verifies basic manifest/ABI metadata. New
`mcp_android_diagnostics` and `mcp_build_artifacts` expose read-only
capabilities and declared artifact paths.

The Android native configuration manager publishes an atomic capability
snapshot with SDK, ABI and observed app permission checks, passed through
`DSH_MCP_ANDROID_CAPABILITIES_FILE`. Root and Shizuku remain explicitly
"not-probed", not authorized. Snapshot status is not a substitute for
real Shizuku/Root permission negotiation. An explicit native Android
SAF picker (MCP Manager > select text document) copies user-selected
UTF-8 text only (maximum 12 files, 128 KiB each) into a private folder;
a dedicated native UI control deletes those copies. Node may only read
the authorized indexed copy at `dsh://android/saf/{id}` after checking
ID, file hash, size and symlink status. `dsh://android/saf` lists
the selected copies but never reveals original `content://` URIs or
scans arbitrary SAF grants.

Native capability snapshots now also contain persisted SAF read grant
count, available memory, low-memory status, thermal status (where supported)
and battery-optimization exemption status. When the workflow scheduler
starts while Android reports low memory or severe thermal pressure, it
limits concurrency to one. Existing `android_logcat` has bounded
time-window filtering; `mcp_android_log_delta` adds a process-local
incremental cursor that never stores raw log output across restarts.

The workflow engine cannot promise execution after the Android process is
killed; background persistence is for recovery, not guaranteed continuation.

Run `node scripts/test-mcp-context.mjs` and `node scripts/test-mcp-log-cursor.mjs`
for resource/prompt/SAF/log safety tests. A green CI result does not establish device integration success.

## Resource budgets

- Project index: at most 4,000 source files and 8 MiB persisted JSON; heuristically extracted symbols and imports.
- Journaled text transaction: at most 16 files, 1 MiB per file, 8 MiB combined, safe-content hash verification. It is **not a whole-filesystem atomic commit**.
- Verification: predefined commands only, 120-second maximum per recipe; a batch contains 1–4 recipes and runs at most 2 concurrently.
- Subagent coordination: 1–64 task nodes, maximum 8 concurrent claims (recommend 3 on Android), per-task write scopes and expiring leases.
- Latency diagnostics: opt-in, in-memory, last 200 samples in the last hour; records tool names and timings, not arguments, logs, messages or credentials.

## Verification and failure modes

| Level | Required evidence |
|---|---|
| Source syntax | Individual `node --check` and CI static regression |
| Module interaction | Transaction crash and conflict injection, coordination and verification adapters |
| Runtime | MCP module packaged in Termux rootfs; complete Runtime graph check |
| APK | Android Gradle Debug assemble succeeds |
| Device | Actual Shizuku/ADB, MCP invocation, storage and long-duration session behavior — not proven by CI |

Do not infer successful Android device behavior from GitHub CI. Preserve the user project's source and original artifacts when a conflict cannot be resolved safely.

## Build

```bash
cd "$HOME/dsh-mobile"
git pull --ff-only origin fix/startup-plugin-recovery-20261013
DSH_PREFLIGHT_ONLY=1 bash build-termux.sh
# If successful, run the complete Android package build:
bash build-termux.sh
```
