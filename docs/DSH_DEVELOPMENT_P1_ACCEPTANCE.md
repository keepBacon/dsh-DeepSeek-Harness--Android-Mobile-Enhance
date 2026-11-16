# DSH Development Engine P1 — Workspace Intelligence

## Implementation scope

P1 adds a persistent incremental project index, unified Workspace MCP query surface, and optional standards-based Language Server Protocol (LSP) client. The index **never writes inside the indexed repository**. Its cache is in `$HOME/.dsh/project-index` (or `DSH_PROJECT_INDEX_DIR` in test environments), keyed by the resolved root path.

P1 tools:

| MCP tool | Behavior |
| --- | --- |
| `workspace_index` | Scan/update changed files, reuse unchanged fingerprints, remove deleted records. |
| `workspace_status` | Query index counts, completeness and analysis confidence. |
| `workspace_symbols` | Cross-file declaration search. |
| `workspace_references` | TypeScript LS references for JS/TS when location provided; language server when installed for other languages; otherwise clearly labeled lexical candidates. |
| `workspace_definition` | TypeScript semantic definition lookup or installed LSP, otherwise explicitly approximate declaration candidates. |
| `workspace_dependencies` | Static local imports and unresolved references. |
| `workspace_impact` | Reverse transitive dependency impact with bounded results. |
| `workspace_diagnostics` | TypeScript parser diagnostics and unresolved local import warnings. |
| `workspace_lsp_status` | Read-only availability for optional installed clangd, Pyright, Kotlin LS, Java JDT LS and Lua LS. |
| `workspace_lsp_query` | Bounded, ephemeral LSP JSON-RPC initialize / didOpen / definition, references or document-symbol request. |

The existing `code_ast_*` APIs remain available; `code_ast_definition` now exposes TypeScript Language Service go-to-definition.

### Supported languages and precision

- **JavaScript / TypeScript:** real syntax parsing via bundled TypeScript compiler; TypeScript Language Service provides precise definition and cross-file references for **up to 128 supplied JS/TS source files**. Larger projects still have indexed static declarations, but exact references need an expanded/persistent language service in a later iteration.
- **C/C++, Python, Java, Kotlin, Lua/Luau:** bounded syntax-shaped heuristics for declarations, imports and lexical reference candidates. A real language server can provide semantic navigation **only when installed and responsive**. LSP is not silently emulated by regex.
- **Shell:** bounded function/source discovery only, with heuristic confidence labels.

## Operational limits

- Maximum 5,000 indexed source files, 1 MiB per source file, 24 levels of traversal, 48 MiB changed-source read budget and 20 MiB serialized cache.
- Ignores common generated trees: `.git`, `node_modules`, `build`, `dist`, `target`, `.gradle`, caches and virtual environments.
- Never follows symlinks during traversal. Project roots are canonicalized. Queries refresh fingerprints and reuse unchanged metadata; deletion invalidates old symbols and dependency edges.
- Imports, module resolution and inverse impact are **static best-effort**. Dynamic imports, generated source, macros, reflective usage and package aliases may be missing.
- A semantic confidence label indicates actual TypeScript Language Service or external LSP evidence; all other references are candidates, not true symbol identity.
- Language servers may have their own caches, CPU or memory demands. The JSON-RPC bridge bounds requests and terminates its child process; DSH cannot guarantee backend compatibility on Android without device tests.

## Device acceptance

After the successful signed APK upgrade, run:

```
workspace_index {"root":"/path/to/project"}
workspace_status {"root":"/path/to/project"}
workspace_symbols {"root":"/path/to/project","query":"main"}
workspace_dependencies {"root":"/path/to/project"}
workspace_impact {"root":"/path/to/project","changedFiles":["src/main.ts"]}
workspace_lsp_status {}
```

Then edit and remove source files in a disposable test project; confirm that subsequent index queries report new symbols and no stale deleted declarations. Test TypeScript definition and references on a real project, and compare Kotlin/Java/C++/Python/Lua heuristics with compiler truth. Optional LSP backends must be installed separately where not included by the Termux runtime.

CI tests:
```sh
node scripts/test-code-engine-ast.mjs
node scripts/test-dsh-project-index.mjs
node scripts/test-dsh-workspace-lsp.mjs
```

Build and MCP-wire integration are also verified by GitHub Actions.

## Remaining semantic gaps

This implementation creates the P1 project-index and LSP **infrastructure**. It does not guarantee bundled Python/Kotlin/Java/Lua language servers, complete multi-language semantic indexing, persistent LSP server sessions or true full-project JS/TS semantic resolution beyond 128 files. It would be inaccurate to describe those as implemented or verified on Android.
