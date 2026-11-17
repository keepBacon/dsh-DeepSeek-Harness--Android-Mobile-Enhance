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
| `dev_plan_cancel` | Request cancellation between steps. Running commands are not forcibly terminated. |
| `dev_plan_resume` | Resume paused plans, with strict handling for unresolved mutations. |
| `dev_plan_recover` | Inspect interrupted steps; verify target file fingerprints and conditionally recover existing P2 transaction journals. |
| `dev_plan_report` | Return a bounded, structured outcome report and suggested next action. |

Supported step kinds: `detect`, `index`, `diagnostics`, `build`, `test`, `verify`, `edit`, `refactor`, `repair`.

## Execution contract

- Plan state is under `$HOME/.dsh/dev-plans`; use `DSH_DEV_PLAN_DIR` only for testing. Plan IDs are random, state persists as atomic snapshots, and each plan acquires a process-shared lock.
- A single run call executes **no more than four steps** with a scheduling budget up to 180 seconds. The deadline is assessed **between** steps; a single build's duration is controlled by its own `timeoutMs` and may exceed the scheduling budget.
- A successful step is checkpointed before the next step. Repeat calls continue from the cursor and do not re-run previously completed steps.
- `when` supports `always`, `onPreviousFailure` and `onPreviousSuccess`; `onFailure` supports `stop` and `continue`, with mutating steps prohibited from silently continuing on failure.
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

- `scripts/test-dsh-dev-plan.mjs` validates plan persistence, phased execution, edits verified through Python build/test, skipped conditions, cancellation and retry decisions.
- `scripts/test-android-mcp-wire.mjs` checks real stdio MCP discovery and plan creation/status through the final runtime bundle.
- GitHub preflight, Runtime Graph, Gradle packaging, and signed ARM64 APK checks are separate tests.
- Real Android app-UID behavior, process-death recovery, physical power-loss durability and long-lived multi-project memory pressure still require device acceptance.

## Remaining P3 phases

This first P3 delivery is a deterministic engineering **execution engine**, not a complete autonomous coding agent. Further work includes dependency-aware task graph scheduling, subprocess cancellation of active builds, more detailed diagnostics-to-repair routing, persistent language-server reuse, and Android true-device recovery benchmarks. Do not mark those as completed.
