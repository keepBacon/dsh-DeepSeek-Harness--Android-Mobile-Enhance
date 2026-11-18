# DSH Development Engine P3 — durable engineering orchestration

## Scope and completion criteria

P3 introduces **explicit, reproducible engineering plans** across the existing P1 index and P2 project build/refactor/verified-edit tools. It does **not** run an autonomous LLM in a background process, promise future delivery, or silently generate edits.

## Interfaces

| Tool | Description |
| --- | --- |
| `dev_plan_create` | Save a bounded engineering plan containing up to 16 typed steps. |
| `dev_plan_run` | Run up to four steps **during the current MCP call**; checkpoints are persisted after every step. No background jobs. |
| `dev_plan_status` | Show current plan and step status without including raw stored edit payloads. |
| `dev_plan_list` | List recently saved plans. |
| `dev_plan_cancel` | Cancel at a safe step boundary, and abort active `build`/`test`/`verify` process groups through the P0 bounded runner. Source mutations finish their P2 rollback journal before a cancellation checkpoint can become resumable. If rollback is unproven, the plan enters `needs_review`. |
| `dev_plan_resume` | Resume paused plans, with strict handling for unresolved mutations. |
| `dev_plan_recover` | Inspect interrupted steps; verify target file fingerprints and conditionally recover existing P2 transaction journals. |
| `dev_plan_report` | Return a bounded, structured outcome report and suggested next action. |

Supported step kinds: `detect`, `index`, `diagnostics`, `build`, `test`, `verify`, `edit`, `refactor`, `repair`.

## Explicit dependency graph (DAG)

Plan steps may declare `dependsOn` as a list of zero-based indices into the **original submitted steps**. Creation validates references, rejects self-dependencies, duplicates and cycles, and persists a stable topological order. The plan status includes both the execution index and the original `sourceIndex`. Plans without dependencies preserve their original order. No parallel execution is implied.

Dependencies require a **passed** prerequisite: if any prerequisite fails or is skipped, the dependent step is skipped with `reason: dependency_not_passed`, and the report identifies `blockedBy` original indices. Unrelated steps may still run after a non-mutating step with `onFailure: continue`. A plan with blocked dependencies reports `completed_with_failures`, not a successful completion.

Example, where source step 0 is deliberately listed before its prerequisites:

```json
{"root":"/path/to/project","steps":[
  {"kind":"verify","dependsOn":[2],"args":{"system":"python","runTests":true}},
  {"kind":"detect"},
  {"kind":"index","dependsOn":[1]}
]}
```

The persisted execution order is detect (source 1), index (source 2), verify (source 0).

## Execution contract

- Plan state is under `$HOME/.dsh/dev-plans`; use `DSH_DEV_PLAN_DIR` only for testing. Plan IDs are random, state persists as atomic snapshots, and each plan acquires a process-shared lock.
- A single run call executes **no more than four steps** with a scheduling budget up to 180 seconds. The deadline is assessed **between** steps; a single build's duration is controlled by its own `timeoutMs` and may exceed the scheduling budget.
- A successful step is checkpointed before the next step. Repeat calls continue from the cursor and do not re-run previously completed steps.
- `when` supports `always`, `onPreviousFailure` and `onPreviousSuccess`; `onFailure` supports `stop` and `continue`, with mutating steps prohibited from silently continuing on failure.
- Active `build`, `test`, and `verify` steps poll cancellation and propagate an AbortSignal into the Android-aware process runner. The same signal may stop the *verification subprocess* of a model-supplied `edit` or `repair`; the source mutation and P2 rollback transaction itself are never killed. A mutating plan is resumable only after rollback succeeds, otherwise it enters `needs_review`. Cancelled checkpoints require explicit `dev_plan_resume`.
- `dev_plan_report.triage` categorizes failures (rollback conflict, cancellation, timeout, missing tool, permission, syntax, test failure, generic build/test) with an actionable, read-only hint. The categorizer never synthesizes patches or silently retries edits.
- Read-only, build and test steps may have up to three explicit retry attempts. Source-mutating steps never retry automatically.
- `repair` tries **model/user-supplied** edit candidates sequentially through `workspace_edit_verify`; a rollback conflict prevents further attempts. There is no arbitrary mutation synthesis.
- On restart, a checkpoint marked `running` cannot simply be retried. Use `dev_plan_recover`. It detects unchanged source fingerprints or uses existing transaction journals for recovery; ambiguous external edits stop with `needs_review`.
- Plan creation does not execute code. A run of a build system executes project-owned build/test programs with DSH app privileges; only use projects whose code you trust.

## Example

```json
{"root":"/path/to/project","name":"Compile and test","steps":[
  {"kind":"detect"},
  {"kind":"index"},
  {"kind":"verify","args":{"system":"cmake","runTests":true}}
]}
```

Call `dev_plan_run` with the created `id`; inspect `dev_plan_status` or `dev_plan_report`. For source edits use an explicit `edit` step with `args.edits` and `args.system`.

## Acceptance tests

- `scripts/test-dsh-dev-plan.mjs` validates plan persistence, DAG scheduling, verified edits, test/build cancellation, cancellation of *active verified-edit checks* with mandatory rollback, explicit resume, triage and retry decisions.
- `scripts/test-dsh-workspace-lsp.mjs` verifies persistent LSP reuse by PID, `didChange` version propagation, bounded session status and explicit server shutdown.
- `scripts/test-dsh-p3-process-death.mjs` kills a real plan worker **after a source edit**, reclaims locks only when their owner PID is dead, restores the P2 transaction journal, then successfully resumes verification. This test runs in GitHub preflight.
- `scripts/test-android-mcp-wire.mjs` checks real stdio MCP discovery and plan creation/status through the final runtime bundle.
- GitHub preflight, Runtime Graph, Gradle packaging, and signed ARM64 APK checks are separate tests.
- Real Android app-UID behavior, process-death recovery, physical power-loss durability and long-lived multi-project memory pressure still require device acceptance.

## Final P3 implementation scope

The source implementation now includes dependency-aware sequential DAG scheduling, persistent document-aware LSP sessions (bounded to two processes, 24 documents per session, two-minute idle eviction with an unref'ed 30-second sweep, per-session serialized queries, explicit close), build/test/verify cancellation, rollback-safe cancellation of verified edits and supplied repair candidates, crash-aware dead-owner lock reclamation and read-only diagnostic triage. No autonomous model agent or unsafe mutation-retry feature is implied.

### Android app-UID acceptance (must run on a device)

The repository includes `scripts/test-dsh-p3-device-acceptance.mjs`. From a checkout with the **real DSH Android app runtime** and Python toolchain available, invoke:

```sh
DSH_P3_ACCEPT_CYCLES=2 node scripts/test-dsh-p3-device-acceptance.mjs
```

It refuses a desktop environment, runs isolated P3 plan, LSP and forced-process-death tests repeatedly, and prints machine-readable results. To store the output, set `DSH_P3_DEVICE_REPORT` to a **new**, private writable path (exclusive create, no overwrite). Do not run on projects with untrusted build/test code.

Android hardware validation additionally needs: app UID/noexec linker routing, upgrade-preserved user data, foreground/background process lifecycle, app memory and battery sampling, and a **separate** physical power-loss test. GitHub CI alone cannot establish these outcomes. Until actual Android reports are collected, report P3 as **source-complete and CI-verified, device acceptance pending** rather than fully hardware-accepted.
