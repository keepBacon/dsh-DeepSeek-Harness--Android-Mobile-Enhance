#!/usr/bin/env node
/**
 * Android compatibility patcher for the published DeepSeek Harness package graph.
 *
 * The Android APK uses one embedded Node process, so unavailable desktop-only
 * native helpers are adapted only at their platform boundary.  Every rewrite
 * is idempotent and anchored; mandatory boot patches fail closed when upstream
 * changes instead of silently producing a broken APK.
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { stripTypeScriptTypes } from 'node:module'

const STRIP_WRAP = { prefix: 'async function __dsh_program__() {\n', suffix: '\n}' }

function unwrapAndroidRunCodeFence(program) {
  const source = String(program)
  const match = /^\s*```(?:ts|typescript|js|javascript)?[ \t]*\r?\n([\s\S]*?)\r?\n```\s*$/i.exec(source)
  return match ? match[1] : source
}

function androidBacktickEscaped(source, index) {
  let slashes = 0
  for (let i = index - 1; i >= 0 && source[i] === '\\'; i--) slashes++
  return slashes % 2 === 1
}

function androidStripCandidate(program) {
  const stripped = stripTypeScriptTypes(STRIP_WRAP.prefix + program + STRIP_WRAP.suffix)
  return stripped.slice(STRIP_WRAP.prefix.length, stripped.length - STRIP_WRAP.suffix.length)
}

function repairAndroidMarkdownTemplateLiteral(program) {
  if (program.length > 1024 * 1024) return program
  const anchor = /(?:\b(?:content|text|body|plan|prompt|markdown|message|patch|html|xml|sql|script|data)\s*:\s*|\b(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*=\s*)`/g
  let found = 0
  for (let match; (match = anchor.exec(program)) !== null && found < 16;) {
    found++
    const open = match.index + match[0].lastIndexOf('`')
    const ticks = []
    for (let i = open + 1; i < program.length && ticks.length < 128; i++) {
      if (program[i] === '`' && !androidBacktickEscaped(program, i)) ticks.push(i)
    }
    if (ticks.length < 3) continue
    for (let k = 2; k < ticks.length; k++) {
      const close = ticks[k]
      const tail = program.slice(close + 1).match(/^\s*/)?.[0].length ?? 0
      const next = program[close + 1 + tail] ?? ''
      if (next && !',;)}].'.includes(next)) continue
      const span = program.slice(open + 1, close)
      if (span.length < 80 && !span.includes('\n')) continue
      const interior = new Set(ticks.slice(0, k))
      let candidate = ''
      for (let i = 0; i < program.length; i++) {
        if (interior.has(i)) candidate += '\\'
        candidate += program[i]
      }
      try {
        androidStripCandidate(candidate)
        return candidate
      } catch {}
    }
  }
  return program
}

function formatAndroidRunCodeSyntaxError(error, program) {
  const raw = error instanceof Error ? error.message : String(error)
  const message = raw.length > 3500 ? raw.slice(0, 3500) + '…' : raw
  const location = /\[(\d+):(\d+)\]/.exec(raw)
  let excerpt = ''
  if (location) {
    const bodyLine = Math.max(1, Number(location[1]) - 1)
    const column = Number(location[2])
    const lines = String(program).split(/\r?\n/)
    const start = Math.max(0, bodyLine - 3)
    const end = Math.min(lines.length, bodyLine + 2)
    const shown = []
    for (let i = start; i < end; i++) shown.push(`${i + 1} | ${lines[i]}`)
    excerpt = `\nProgram location: line ${bodyLine}, column ${column}\n${shown.join('\n')}`
  }
  return `${message}${excerpt}\nDSH Android syntax guard: run_code accepts TypeScript source, not Markdown. Do not wrap Markdown, code fences, HTML, JSON, shell scripts, or arbitrary long text in JavaScript backtick template literals; embedded backticks can terminate the literal and cause Expression expected. Keep the program small and pass text with JSON-safe quoted strings or content-oriented tool calls.`
}

function androidStripRunCodeProgram(program) {
  const source = unwrapAndroidRunCodeFence(program)
  try {
    return androidStripCandidate(source)
  } catch (firstError) {
    const repaired = repairAndroidMarkdownTemplateLiteral(source)
    if (repaired !== source) {
      try { return androidStripCandidate(repaired) } catch {}
    }
    throw new SyntaxError(formatAndroidRunCodeSyntaxError(firstError, source))
  }
}

function runAndroidCodeModeCompatSelfTest() {
  const valid = 'const value: number = 7; return value'
  if (!androidStripRunCodeProgram(valid).includes('return value')) throw new Error('valid TypeScript strip failed')
  const fenced = ['```ts', 'const value: number = 9; return value', '```'].join('\n')
  if (!androidStripRunCodeProgram(fenced).includes('return value')) throw new Error('fenced TypeScript unwrap failed')
  const broken = [
    'const payload = { plan: `# Build plan',
    'Use `*.xmf` and `mesh.h` in the generated Markdown.',
    '` };',
    'return payload.plan;',
  ].join('\n')
  let rejected = false
  try { androidStripCandidate(broken) } catch { rejected = true }
  if (!rejected) throw new Error('broken Markdown template unexpectedly parsed')
  const repaired = androidStripRunCodeProgram(broken)
  if (!repaired.includes('\\`*.xmf\\`')) throw new Error('Markdown backtick repair did not run')
  const safe = 'const a = `x`; const b = `y`; return a + b'
  if (!androidStripRunCodeProgram(safe).includes('const a')) throw new Error('valid template literals changed')
  try {
    androidStripRunCodeProgram('const value = { a: 1 b: 2 }; return value')
    throw new Error('invalid object unexpectedly parsed')
  } catch (error) {
    if (!String(error).includes('syntax guard')) throw error
  }
  console.log('[DSH] Android run_code TypeScript compatibility self-test: OK')
}

if (process.argv[2] === '--self-test') {
  runAndroidCodeModeCompatSelfTest()
  process.exit(0)
}

const prefix = path.resolve(process.argv[2] || '')
if (!prefix || prefix === path.resolve('.')) {
  console.error('usage: node android-runtime-patch.mjs <runtime-prefix>')
  process.exit(2)
}
const modulesRoot = path.join(prefix, 'lib', 'node_modules')
const report = []

const targetVersion = process.env.DSH_TARGET_VERSION || ''
function parseSemver(value) {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-(alpha|beta|rc)\.(\d+))?/.exec(String(value).trim())
  if (!m) return null
  const rank = m[4] === 'alpha' ? 0 : m[4] === 'beta' ? 1 : m[4] === 'rc' ? 2 : 3
  return [Number(m[1]), Number(m[2]), Number(m[3]), rank, Number(m[5] || 0)]
}
function versionAtLeast(value, floor) {
  const a = parseSemver(value), b = parseSemver(floor)
  if (!a || !b) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return a[i] > b[i]
  }
  return true
}
const requireBuiltinMandatory = versionAtLeast(targetVersion, '0.1.6-alpha.2')
const androidStableStorageMandatory = versionAtLeast(targetVersion, '0.1.5-rc.1')
const androidFlockMandatory = versionAtLeast(targetVersion, '0.1.5-rc.1')
const androidPermissionPresetGuardMandatory = versionAtLeast(targetVersion, '0.1.5-rc.2')
const androidCodeModeCompatMandatory = versionAtLeast(targetVersion, '0.1.5-rc.2') && !versionAtLeast(targetVersion, '0.1.6-alpha.0')
const warn = (msg) => console.error(`[DSH Android compat] WARN: ${msg}`)
const info = (name, status, file = '') => report.push({ name, status, file: file ? path.relative(prefix, file) : '' })

function read(file) { try { return fs.readFileSync(file, 'utf8') } catch { return '' } }
function write(file, text) { fs.writeFileSync(file, text) }

function packageDirsByName(wanted) {
  const out = []
  const seen = new Set()
  const stack = [modulesRoot]
  while (stack.length) {
    const dir = stack.pop()
    let ents
    try { ents = fs.readdirSync(dir, { withFileTypes: true }) } catch { continue }
    const manifest = path.join(dir, 'package.json')
    if (fs.existsSync(manifest)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(manifest, 'utf8'))
        if (wanted.has(pkg.name) && !seen.has(dir)) { seen.add(dir); out.push(dir) }
      } catch {}
    }
    for (const ent of ents) {
      if (!ent.isDirectory()) continue
      if (ent.name === '.cache' || ent.name === '.git' || ent.name === 'build' || ent.name === 'prebuilds') continue
      stack.push(path.join(dir, ent.name))
    }
  }
  return out
}

const wanted = new Set([
  'node-addon-require-builtin',
  '@deepseek-ai/node-addon-system',
  '@deepseek-ai/dsh-session-persistence-jsonl',
  '@deepseek-ai/dsh-attachment-local',
  '@deepseek-ai/dsh-fs-local',
  '@deepseek-ai/dsh-tool-fs-search',
  '@vscode/ripgrep',
  '@deepseek-ai/dsh-settings',
  '@deepseek-ai/dsh-permission-presets',
  '@deepseek-ai/dsh-llm-pi-ai',
  '@deepseek-ai/dsh-client-modules',
  '@deepseek-ai/dsh-code-runtime-worker-thread',
  '@deepseek-ai/dsh-tools',
  '@deepseek-ai/dsh-sandbox-local',
  '@deepseek-ai/dsh-subprocess-local',
  '@deepseek-ai/dsh-terminal-bash',
])
const dirs = packageDirsByName(wanted)
const byName = new Map()
for (const dir of dirs) {
  try {
    const name = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).name
    if (!byName.has(name)) byName.set(name, [])
    byName.get(name).push(dir)
  } catch {}
}

function eachPackage(name, relFile, fn, { mandatory = false, requiredIfPresent = false } = {}) {
  const packages = byName.get(name) ?? []
  if (!packages.length) {
    if (mandatory) throw new Error(`mandatory package not found: ${name}`)
    warn(`${name} not installed; skip`)
    info(name, 'missing')
    return
  }
  let ok = 0
  for (const dir of packages) {
    const file = path.join(dir, relFile)
    if (!fs.existsSync(file)) {
      if (mandatory || requiredIfPresent) throw new Error(`required patch target missing: ${file}`)
      warn(`${name}: ${relFile} missing; skip this instance`)
      info(name, 'target-missing', file)
      continue
    }
    const status = fn(file)
    info(name, status, file)
    if (status === 'patched' || status === 'already' || status === 'upstream-safe') ok++
  }
  if ((mandatory || requiredIfPresent) && ok !== packages.length) {
    throw new Error(`required Android compatibility patch incomplete: ${name} (${ok}/${packages.length})`)
  }
}


function checkPatchedJavaScript(file) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' })
  if (result.status !== 0) throw new Error(`patched JavaScript failed syntax check: ${file}\n${result.stderr || result.stdout}`)
}

function patchCodeRuntimeWorker(indexFile) {
  let txt = read(indexFile)
  const marker = 'DSH Android compat: resilient run_code TypeScript syntax'
  if (txt.includes(marker)) return 'already'
  if (!txt.includes('stripTypeScriptTypes') || !txt.includes('request.program')) {
    warn(`code-runtime worker strip target changed: ${indexFile}`)
    return 'anchor-missing'
  }
  const insertionAnchor = /function\s+waitForPipeDrain\s*\(/
  const insertionMatches = txt.match(new RegExp(insertionAnchor.source, 'g')) ?? []
  if (insertionMatches.length !== 1) {
    warn(`code-runtime worker helper anchor changed (${insertionMatches.length}): ${indexFile}`)
    return 'anchor-missing'
  }
  const helpers = [
    `// ${marker}.`,
    unwrapAndroidRunCodeFence.toString(),
    androidBacktickEscaped.toString(),
    repairAndroidMarkdownTemplateLiteral.toString(),
    formatAndroidRunCodeSyntaxError.toString(),
    `function androidStripCandidate(program) {\n  const stripped = stripTypeScriptTypes(STRIP_WRAP.prefix + program + STRIP_WRAP.suffix);\n  return stripped.slice(STRIP_WRAP.prefix.length, stripped.length - STRIP_WRAP.suffix.length);\n}`,
    `function androidStripRunCodeProgram(program) {\n  const source = unwrapAndroidRunCodeFence(program);\n  try { return androidStripCandidate(source); } catch (firstError) {\n    const repaired = repairAndroidMarkdownTemplateLiteral(source);\n    if (repaired !== source) { try { return androidStripCandidate(repaired); } catch {} }\n    throw new SyntaxError(formatAndroidRunCodeSyntaxError(firstError, source));\n  }\n}`,
  ].join('\n\n') + '\n\n'
  txt = txt.replace(insertionAnchor, helpers + insertionMatches[0])

  const stripBlock = /const\s+stripped\s*=\s*stripTypeScriptTypes\(\s*STRIP_WRAP\.prefix\s*\+\s*request\.program\s*\+\s*STRIP_WRAP\.suffix\s*\)\s*;?\s*code\s*=\s*stripped\.slice\(\s*STRIP_WRAP\.prefix\.length\s*,\s*stripped\.length\s*-\s*STRIP_WRAP\.suffix\.length\s*\)\s*;?/
  const stripMatches = txt.match(new RegExp(stripBlock.source, 'g')) ?? []
  if (stripMatches.length !== 1) {
    warn(`code-runtime worker strip block changed (${stripMatches.length}): ${indexFile}`)
    return 'anchor-missing'
  }
  txt = txt.replace(stripBlock, 'code = androidStripRunCodeProgram(request.program);')
  write(indexFile, txt)
  checkPatchedJavaScript(indexFile)
  return 'patched'
}

function patchCodeModeGuidance(indexFile) {
  const packageDir = path.resolve(path.dirname(indexFile), '..')
  const files = walkJavaScriptFiles(path.join(packageDir, 'lib'))
  const guidance = ' Keep run_code programs small. Never embed Markdown, code fences, HTML, JSON, shell scripts, or arbitrary user text inside JavaScript template literals; those payloads may contain backticks and make the TypeScript invalid. Prefer JSON-safe quoted strings or a content-oriented tool call.'
  let changed = 0
  let already = false
  for (const file of files) {
    let txt = read(file)
    if (!txt) continue
    if (txt.includes('Never embed Markdown, code fences, HTML, JSON, shell scripts')) { already = true; continue }
    const anchor = 'Tool arguments must be lossless JSON.'
    if (!txt.includes(anchor)) continue
    txt = txt.replace(anchor, anchor + guidance)
    write(file, txt)
    checkPatchedJavaScript(file)
    changed++
  }
  if (changed > 0) return 'patched'
  if (already) return 'already'
  warn(`dsh-tools Code Mode guidance anchor changed under: ${packageDir}`)
  return 'anchor-missing'
}

// Android-specific hardening for Code Mode syntax failures. The runtime first
// accepts accidental outer Markdown fences, then repairs only the narrow,
// parser-verified case where a long text/template literal contains Markdown
// backticks. All other syntax failures stay failures, but now include a useful
// location/excerpt and an explicit recovery instruction instead of the bare
// "Expression expected" loop.
eachPackage('@deepseek-ai/dsh-code-runtime-worker-thread', 'lib/index.js', patchCodeRuntimeWorker, {
  requiredIfPresent: androidCodeModeCompatMandatory,
})
eachPackage('@deepseek-ai/dsh-tools', 'lib/index.js', patchCodeModeGuidance)

// StepFun Plan can emit an in-band EOF diagnostic after already streaming
// usable assistant content. DSH 0.1.5-rc.2 classifies every such pi-ai error as
// TRANSPORT, so llm-retry repeats the entire request up to its retry budget.
// Normalize only this provider + these known terminal wordings at the DSH-owned
// adapter seam. Real socket/network failures and every other provider remain
// errors and keep the normal retry behavior.
eachPackage('@deepseek-ai/dsh-llm-pi-ai', 'lib/index.js', (file) => {
  let txt = read(file)
  const marker = 'DSH Android compat: StepFun Plan incomplete-terminal normalization'
  if (txt.includes(marker)) return 'already'

  const functionAnchor = /function\s+mapStopReason\s*\(\s*message\s*,\s*contextWindow\s*\)\s*\{/
  const matches = txt.match(new RegExp(functionAnchor.source, 'g')) ?? []
  if (matches.length !== 1) {
    throw new Error(`StepFun Plan mapStopReason anchor changed (${matches.length} matches): ${file}`)
  }
  const injection = `${matches[0]}
  // ${marker}.
  const stepFunPlanProvider = typeof message.provider === "string"
    && (message.provider === "stepfun-plan" || message.provider.startsWith("stepfun-plan:"));
  const stepFunPlanTerminalText = typeof message.errorMessage === "string"
    && /(?:upstream\\s+)?stream ended before a completion event|stream ended without finish_reason/i.test(message.errorMessage);
  if (message.stopReason === "error"
    && stepFunPlanProvider
    && Array.isArray(message.content)
    && message.content.length > 0
    && stepFunPlanTerminalText) {
    return message.content.some((block) => block?.type === "toolCall")
      ? { kind: "tool-calls" }
      : { kind: "stop" };
  }`
  txt = txt.replace(functionAnchor, injection)
  write(file, txt)
  return 'patched'
}, { requiredIfPresent: versionAtLeast(targetVersion, '0.1.5-rc.2') })

// DSH 0.1.5-rc.2's /plugins/?? combo route is unreliable when the package
// graph is installed under a non-default prefix (the Android runtime always is).
// Patch the published HOST artifact, not the browser bundle: npm lib/client.js is
// bundled/transformed and is intentionally not used as a source-shape anchor.
// Android publishes one direct /plugins/<package>/client.js?rev=... response per
// startup row and schedules one row per batch. The response table is built from
// the same rewritten URLs, so serving and advertising stay internally consistent.
// HOME/profile/session/workspace data are not touched.
eachPackage('@deepseek-ai/dsh-client-modules', 'lib/index.js', (file) => {
  let txt = read(file)
  const marker = 'DSH Android compat: direct single-resource client routes'
  if (txt.includes(marker)) return 'already'

  const comboAnchor = /function\s+comboUrl\s*\(\s*ids\s*,\s*rev\s*,\s*sourceMap\s*=\s*false\s*\)\s*\{/
  const comboMatches = txt.match(new RegExp(comboAnchor.source, 'g')) ?? []
  if (comboMatches.length !== 1) {
    throw new Error(`client-modules comboUrl anchor changed (${comboMatches.length} matches): ${file}`)
  }
  const comboInjection = `${comboMatches[0]}
  // ${marker}
  if (process.env.DSH_ANDROID_STANDALONE === "1" && ids.length === 1) {
    const resource = ids[0] + "/client.js" + (sourceMap ? ".map" : "");
    return "/plugins/" + resource + "?rev=" + rev;
  }`
  txt = txt.replace(comboAnchor, comboInjection)

  const partitionAnchor = /function\s+partitionComboRecords\s*\(\s*records\s*\)\s*\{/
  const partitionMatches = txt.match(new RegExp(partitionAnchor.source, 'g')) ?? []
  if (partitionMatches.length !== 1) {
    throw new Error(`client-modules partition anchor changed (${partitionMatches.length} matches): ${file}`)
  }
  const partitionInjection = `${partitionMatches[0]}
  if (process.env.DSH_ANDROID_STANDALONE === "1") {
    return records.map((record) => [record]);
  }`
  txt = txt.replace(partitionAnchor, partitionInjection)

  write(file, txt)
  return 'patched'
}, { requiredIfPresent: versionAtLeast(targetVersion, '0.1.5-rc.2') })


// Android cannot rely on desktop Linux bwrap/Landlock from an ordinary app UID.
// Keep the DSH sandbox seam active instead of falling through to
// danger-full-access: confined calls go through our explicit runner and report
// partial enforcement. fs-sandbox continues to enforce model file mutations by
// canonical workspace containment; Android's app UID is the outer OS boundary.
eachPackage('@deepseek-ai/dsh-sandbox-local', 'lib/index.js', (file) => {
  let txt = read(file)
  const marker = 'DSH Android compat: partial app-UID sandbox runner'
  if (txt.includes(marker)) return 'already'
  const anchor = /confine\s*\(\s*argv\s*,\s*policy\s*\)\s*\{/
  const matches = txt.match(new RegExp(anchor.source, 'g')) ?? []
  if (matches.length !== 1) throw new Error(`sandbox-local confine anchor changed (${matches.length}): ${file}`)
  const injection = `${matches[0]}
    // ${marker}.
    if (process.env.DSH_ANDROID_STANDALONE === "1") {
      const runner = process.env.DSH_ANDROID_SANDBOX_RUNNER;
      if (!runner) {
        throw new Error("DSH Android sandbox runner path is missing");
      }
      return {
        argv: [runner, policy.mode, policy.workspaceRoot, "--", ...argv],
        enforcement: "partial",
        denialSignatures: ["permission denied", "read-only file system", "operation not permitted"],
        runnerFailureRules: [{
          allowedExitCodes: [125],
          fatalSignatures: ["dsh-android-sandbox: runner failure:"]
        }]
      };
    }`
  txt = txt.replace(anchor, injection)
  write(file, txt)
  checkPatchedJavaScript(file)
  return 'patched'
}, { mandatory: androidPermissionPresetGuardMandatory })

// subprocess-local sees Android Node as linux. Its desktop Linux containment
// path probes systemd-run / native Linux helpers that are unavailable or
// meaningless inside an Android app sandbox. Force the provider's documented
// fallback containment mode; node-pty and ordinary spawn remain the same.
eachPackage('@deepseek-ai/dsh-subprocess-local', 'lib/index.js', (file) => {
  let txt = read(file)
  const marker = 'DSH Android compat: skip desktop linux-scope'
  if (txt.includes(marker)) return 'already'
  const anchor = /selectContainmentMode\s*\(\s*kind\s*\)\s*\{/
  const matches = txt.match(new RegExp(anchor.source, 'g')) ?? []
  if (matches.length !== 1) throw new Error(`subprocess-local containment anchor changed (${matches.length}): ${file}`)
  const injection = `${matches[0]}
    // ${marker}.
    if (process.env.DSH_ANDROID_STANDALONE === "1") {
      this.warnFallback?.(kind, "Android app runtime uses the app UID/process-session boundary");
      return "fallback";
    }`
  txt = txt.replace(anchor, injection)
  write(file, txt)
  checkPatchedJavaScript(file)
  return 'patched'
}, { mandatory: androidPermissionPresetGuardMandatory })

// terminal-bash defaults to /bin/bash on POSIX desktops. Android has no /bin
// Bash; the APK already publishes the relocated embedded shell through
// DSH_SIDEBAR_SHELL/SHELL.
eachPackage('@deepseek-ai/dsh-terminal-bash', 'lib/index.js', (file) => {
  let txt = read(file)
  const marker = 'DSH Android compat: embedded Bash default'
  if (txt.includes(marker)) return 'already'
  const anchor = /((?:const|let|var)\s+DEFAULT_BASH_SHELL\s*=\s*)["']\/bin\/bash["']/
  const matches = txt.match(new RegExp(anchor.source, 'g')) ?? []
  if (matches.length !== 1) throw new Error(`terminal-bash DEFAULT_BASH_SHELL anchor changed (${matches.length}): ${file}`)
  txt = txt.replace(anchor, (_m, prefix) =>
    `${prefix}process.env.DSH_ANDROID_STANDALONE === "1" ? (process.env.DSH_SIDEBAR_SHELL || process.env.SHELL || "/bin/bash") : "/bin/bash" /* ${marker} */`)
  write(file, txt)
  checkPatchedJavaScript(file)
  return 'patched'
}, { mandatory: androidPermissionPresetGuardMandatory })

// Preserve the exact permission defaults composed by the active plugin stack.
  // Upstream 0.1.5-rc.2 deliberately throws when sandbox + approval form a valid
  // custom pair that is not named in the configured preset table. On Android
  // that turns an otherwise-working plugin into a permanent Host boot failure.
  //
  // Add one stable internal preset mirroring the effective composed defaults.
  // Existing presets stay first, so ordinary read-only/workspace-write/full
  // access behavior is unchanged whenever it already matches. When a plugin
  // intentionally composes a different valid pair, the synthetic preset makes
  // that exact pair representable without disabling, rewriting, or removing
  // any plugin bundle.
  eachPackage('@deepseek-ai/dsh-permission-presets', 'lib/index.js', (file) => {
    let txt = read(file)
    const marker = 'DSH Android compat: preserve composed permission defaults'
    if (txt.includes(marker)) return 'already'

    const assignment = /this\.presets\s*=\s*config\.presets\s*;?/
    if (!assignment.test(txt)) {
      if (androidPermissionPresetGuardMandatory) throw new Error(`permission preset constructor anchor changed: ${file}`)
      warn(`permission preset constructor anchor changed: ${file}`)
      return 'anchor-missing'
    }

    const replacement = `this.presets = { ...config.presets };
      // ${marker}. This preset follows the plugin-composed deployment defaults.
      // Standard configured presets remain earlier in insertion order and win
      // whenever they already describe the same sandbox/approval pair.
      const androidComposedDefault = "__dsh_android_composed_default__";
      this.presets[androidComposedDefault] = {
        sandbox: ctx.shell.sandboxMode,
        approval: ctx.approval.config.policy ?? "ask",
        name: "Follow plugin default",
        description: "Uses the sandbox and approval defaults composed by the active plugin stack."
      };`

    write(file, txt.replace(assignment, replacement))
    return 'patched'
  }, { mandatory: androidPermissionPresetGuardMandatory })

  // DSH 0.1.6-alpha.2: profile resolution loads node-addon-require-builtin in
// host preparation, but that package publishes no android-arm64 binary.  The
// package is an unrestricted proxy around require(); --expose-internals is
// already supplied by EngineManager, so a JS fallback preserves its contract.
eachPackage('node-addon-require-builtin', 'lib/index.js', (file) => {
  let txt = read(file)
  const marker = 'DSH Android compat: node-addon-require-builtin JS fallback'
  if (txt.includes(marker)) return 'already'
  const anchor = "const api = createEntryApi(node_path_1.default.resolve(__dirname, '..'));"
  if (!txt.includes(anchor)) throw new Error(`node-addon-require-builtin anchor changed: ${file}`)
  const replacement = `/* ${marker}.  Android has no published native binding;\n   EngineManager starts Node with --expose-internals, so direct require keeps\n   the unrestricted requireBuiltin contract. */\nlet api;\ntry {\n  api = createEntryApi(node_path_1.default.resolve(__dirname, '..'));\n} catch (nativeError) {\n  api = {\n    requireBuiltin: (moduleId) => require(moduleId),\n    isAllowedInternalId: () => true,\n    getBindingInfo: () => ({ source: 'android-js-fallback' }),\n  };\n}`
  write(file, txt.replace(anchor, replacement))
  return 'patched'
}, { mandatory: requireBuiltinMandatory })

// Session leases use flock for cross-process writer exclusion.  This APK owns
// one DSH engine process, while the in-process claim still serializes writers.
eachPackage('@deepseek-ai/node-addon-system', 'lib/flock.js', (file) => {
  let txt = read(file)
  const marker = 'DSH Android compat: single-process flock fallback'
  if (txt.includes(marker)) return 'already'
  const anchor = '    const { platform, arch } = process;'
  if (!txt.includes(anchor)) { warn(`flock anchor changed: ${file}`); return 'anchor-missing' }
  const block = `${anchor}\n    // ${marker}.\n    if (platform === 'android') {\n        binding = { tryLock: (_fd, callback) => callback(0) };\n        return binding;\n    }`
  write(file, txt.replace(anchor, block))
  return 'patched'
}, { mandatory: androidFlockMandatory })

function ensureFsPromisesImport(text, names) {
  const re = /(import\s*\{)([^}]*)(\}\s*from\s*["']node:fs\/promises["'];?)/
  const m = re.exec(text)
  if (!m) return text
  const have = new Set(m[2].split(',').map(v => v.trim()).filter(Boolean))
  const missing = names.filter(n => !have.has(n))
  if (!missing.length) return text
  const middle = m[2].trimEnd() + (m[2].trim() ? ', ' : '') + missing.join(', ')
  return text.slice(0, m.index) + m[1] + middle + m[3] + text.slice(m.index + m[0].length)
}

// Android shared storage rejects hard links on many devices/ROMs.  The staged
// session file is on the same filesystem; rename keeps atomic publication.
eachPackage('@deepseek-ai/dsh-session-persistence-jsonl', 'lib/index.js', (file) => {
  let txt = read(file)
  let changed = false
  if (!txt.includes('DSH Android compat: session link to rename')) {
    const re = /([ \t]*)await link\(\s*tmp\s*,\s*finalPath\s*\);/
    const m = re.exec(txt)
    if (m) {
      txt = txt.replace(re, `$1// DSH Android compat: session link to rename (shared storage rejects link).\n$1await rename(tmp, finalPath);`)
      txt = ensureFsPromisesImport(txt, ['rename'])
      changed = true
    } else {
      if (androidStableStorageMandatory) throw new Error(`session materialize anchor changed: ${file}`)
      warn(`session materialize anchor not present (may be upstream-fixed): ${file}`)
    }
  }
  if (txt.includes('async function publishCurrentExclusive(') && !txt.includes('DSH Android compat: publishCurrentExclusive')) {
    const old = `\ttry {\n\t\tawait internals.fs.link(staged, currentPath);\n\t} catch (error) {\n\t\t/* v8 ignore else -- a non-collision filesystem error propagates unchanged. */\n\t\tif (isEEXIST(error)) return false;\n\t\t/* v8 ignore next -- the filesystem error is already complete. */\n\t\tthrow error;\n\t}`
    if (txt.includes(old)) {
      const repl = `\t// DSH Android compat: publishCurrentExclusive; preserve EEXIST semantics,\n\t// fall back to same-filesystem rename when hard links are forbidden.\n\ttry {\n\t\tawait internals.fs.link(staged, currentPath);\n\t} catch (error) {\n\t\tif (isEEXIST(error)) return false;\n\t\tif (!(error instanceof Error && 'code' in error && (error.code === 'EPERM' || error.code === 'EACCES'))) throw error;\n\t\tlet existed = true;\n\t\ttry { await internals.fs.lstat(currentPath); } catch (probeError) {\n\t\t\tif (!(probeError instanceof Error && 'code' in probeError && probeError.code === 'ENOENT')) throw probeError;\n\t\t\texisted = false;\n\t\t}\n\t\tif (existed) return false;\n\t\tawait rename(staged, currentPath);\n\t}`
      txt = txt.replace(old, repl)
      txt = ensureFsPromisesImport(txt, ['rename'])
      changed = true
    } else {
      if (androidStableStorageMandatory) throw new Error(`publishCurrentExclusive anchor changed: ${file}`)
      warn(`publishCurrentExclusive anchor changed: ${file}`)
    }
  }
  if (androidStableStorageMandatory) {
    if (!txt.includes('DSH Android compat: session link to rename')) {
      throw new Error(`session materialize patch missing after rewrite: ${file}`)
    }
    if (txt.includes('async function publishCurrentExclusive(') && !txt.includes('DSH Android compat: publishCurrentExclusive')) {
      throw new Error(`session publishCurrentExclusive patch missing after rewrite: ${file}`)
    }
  }
  if (changed) { write(file, txt); return 'patched' }
  return txt.includes('DSH Android compat:') ? 'already' : 'no-op'
}, { mandatory: androidStableStorageMandatory })

// Workspace create-if-absent publication has the same hard-link limitation.
eachPackage('@deepseek-ai/dsh-fs-local', 'lib/index.js', (file) => {
  let txt = read(file)
  const marker = 'DSH Android compat: /storage hard-link fallback'
  if (txt.includes(marker)) return 'already'
  const re = /([ \t]+)await throwGuardedCreateFailure\(error, absolutePath, createIfAbsent\.displayPath, inspectPublicationTarget\);/
  const m = re.exec(txt)
  if (!m) { warn(`fs-local create anchor changed: ${file}`); return 'anchor-missing' }
  const i = m[1]
  const block = `${i}let existing;\n${i}try {\n${i}\texisting = await inspectPublicationTarget(absolutePath);\n${i}} catch (metadataError) {\n${i}\tif (!isENOENT(metadataError) && !isENOTDIR(metadataError)) throw metadataError;\n${i}}\n${i}if (existing !== void 0) {\n${i}\tawait throwGuardedCreateFailure(error, absolutePath, createIfAbsent.displayPath, inspectPublicationTarget);\n${i}}\n${i}// ${marker}.\n${i}await rename(tempPath, absolutePath);`
  txt = txt.replace(re, block)
  txt = ensureFsPromisesImport(txt, ['rename'])
  write(file, txt)
  return 'patched'
}, { mandatory: androidStableStorageMandatory })

// @vscode/ripgrep has no android-arm64 platform package.  Patch the resolver
// itself so every consumer (including fs-search and third-party plugins) can
// use the APK-bundled native rg through DSH_RG_PATH.  This is the most stable
// compatibility seam because fs-search's published bundle layout can change.
eachPackage('@vscode/ripgrep', 'lib/index.js', (file) => {
  let txt = read(file)
  const marker = 'DSH Android compat: DSH_RG_PATH override'
  if (txt.includes(marker)) return 'already'
  if (!txt.includes('platformPkg') || !txt.includes('rgPath')) {
    warn(`@vscode/ripgrep resolver shape changed: ${file}`)
    return 'anchor-missing'
  }

  // Current @vscode/ripgrep publishes `let resolved; try { resolved = ... }`.
  // Initialize that variable from our known-good Android rg path and skip the
  // unsupported platform-package lookup entirely when it is present.
  const resolvedDecl = /let\s+resolved\s*;/
  const tryAfterResolved = /let\s+resolved\s*;([\s\S]*?)\btry\s*\{/
  if (resolvedDecl.test(txt) && tryAfterResolved.test(txt)) {
    txt = txt.replace(resolvedDecl, `let resolved = process.env.DSH_RG_PATH || undefined; // ${marker}`)
    txt = txt.replace(/(DSH_RG_PATH override[^\n]*\n?)([\s\S]*?)\btry\s*\{/, (all, mark, middle) => `${mark}${middle}if (!resolved) try {`)
    write(file, txt)
    return 'patched'
  }

  // Fallback for older builds that assign/export rgPath directly.
  const directExport = /export\s+const\s+rgPath\s*=\s*([^;]+);/
  if (directExport.test(txt)) {
    txt = txt.replace(directExport, (_m, expr) => `export const rgPath = process.env.DSH_RG_PATH || (${expr}); // ${marker}`)
    write(file, txt)
    return 'patched'
  }

  warn(`@vscode/ripgrep resolver anchor changed: ${file}`)
  return 'anchor-missing'
}, { requiredIfPresent: androidStableStorageMandatory })

function ripgrepResolverOverrideReady() {
  const packages = byName.get('@vscode/ripgrep') ?? []
  if (!packages.length) return false
  return packages.every(dir => read(path.join(dir, 'lib/index.js')).includes('DSH Android compat: DSH_RG_PATH override'))
}

// File-search uses @vscode/ripgrep, which does not publish Android binaries.
// Published DSH builds have used both bundled lib/index.js and split
// lib/search-core.js layouts, and bundlers may change quote style.  Patch the
// actual dynamic-import site instead of pinning one output filename/string.
function walkJavaScriptFiles(dir) {
  const out = []
  const stack = [dir]
  while (stack.length) {
    const current = stack.pop()
    let entries
    try { entries = fs.readdirSync(current, { withFileTypes: true }) } catch { continue }
    for (const entry of entries) {
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) {
        if (entry.name !== 'node_modules' && entry.name !== '.git') stack.push(full)
      } else if (entry.isFile() && /\.(?:c|m)?js$/i.test(entry.name)) {
        out.push(full)
      }
    }
  }
  return out
}

function patchFsSearchPackage(indexFile) {
  const pkgDir = path.resolve(path.dirname(indexFile), '..')
  const libDir = path.join(pkgDir, 'lib')
  const files = walkJavaScriptFiles(libDir)
  if (!files.length) {
    warn(`fs-search has no JavaScript output under ${libDir}`)
    return 'anchor-missing'
  }

  let sawAlready = false
  let patched = 0
  const directReturnImport = /return\s*\(\s*await\s+import\(\s*(["'])@vscode\/ripgrep\1\s*\)\s*\)\.rgPath\s*;/g
  // 0.1.5-rc.2's published bundle uses an intermediate variable:
  //   let rgPath = (await import("@vscode/ripgrep")).rgPath;
  //   ...
  //   return rgPath;
  // Short-circuit the import itself so Android never asks @vscode/ripgrep for
  // the nonexistent @vscode/ripgrep-android-arm64 package.
  const assignedImport = /((?:let|const|var)\s+[A-Za-z_$][\w$]*\s*=\s*)\(\s*await\s+import\(\s*(["'])@vscode\/ripgrep\2\s*\)\s*\)\.rgPath\s*;/g

  for (const candidate of files) {
    let txt = read(candidate)
    if (!txt || !txt.includes('@vscode/ripgrep')) continue
    if (txt.includes('DSH Android compat: external rg path')) {
      sawAlready = true
      continue
    }
    let next = txt.replace(assignedImport, (_match, prefix, quote) =>
      `${prefix}process.env.DSH_RG_PATH || (await import(${quote}@vscode/ripgrep${quote})).rgPath; // DSH Android compat: external rg path`)
    next = next.replace(directReturnImport, (match) =>
      `return process.env.DSH_RG_PATH || ${match.slice('return '.length).replace(/;$/, '')}; // DSH Android compat: external rg path`)
    if (next !== txt) {
      write(candidate, next)
      patched++
    }
  }

  if (patched > 0) return 'patched'
  if (sawAlready) return 'already'
  // If the lower-level @vscode/ripgrep resolver already honors DSH_RG_PATH,
  // this package is safe even when its bundler rewrites the import site beyond
  // recognition.  Treat that verified resolver seam as upstream-safe instead
  // of rejecting a healthy runtime.
  if (ripgrepResolverOverrideReady()) return 'upstream-safe'
  warn(`fs-search ripgrep dynamic-import anchor changed under: ${libDir}`)
  return 'anchor-missing'
}

eachPackage('@deepseek-ai/dsh-tool-fs-search', 'lib/index.js', patchFsSearchPackage, {
  requiredIfPresent: androidStableStorageMandatory,
})

// Preserve community plugins built against the pre-0.1.2 dsh-settings helpers.
eachPackage('@deepseek-ai/dsh-settings', 'lib/index.js', (file) => {
  let txt = read(file)
  const marker = 'DSH Android compat: legacy settings exports'
  if (txt.includes(marker)) return 'already'
  const anchor = 'export { SettingsConflictError, SettingsProvider, SettingsProvider as default, redactSecrets };'
  if (!txt.includes(anchor)) {
    // Newer upstream may have restored/changed these exports. Never mutate a
    // different export shape blindly; plugin manager can still report its own error.
    warn(`settings compatibility export shape changed: ${file}`)
    return 'anchor-missing'
  }
  const shim = `\n//#region ${marker}\nfunction settingsNamespace(value) {\n\tif (!NAMESPACE_PATTERN.test(value)) throw new TypeError(\`settings namespace "\${value}" must match \${String(NAMESPACE_PATTERN)}\`);\n\treturn value;\n}\nfunction installSettingsSection(ctx, ns, schema, entry, hooks) {\n\tctx.inject(["settings"], (sctx) => { sctx.settings.installSection(ctx, ns, schema, entry, hooks); });\n}\n//#endregion\n`
  const replacement = 'export { SettingsConflictError, SettingsProvider, SettingsProvider as default, deepEqualJson, installSettingsSection, redactSecrets, settingsNamespace };'
  write(file, txt.replace(anchor, shim + replacement))
  return 'patched'
})

// Attachment hard-link paths vary across DSH releases; apply conservative
// targeted rewrites only when exact shapes are found.  Sharp is handled by a
// WASM fallback at build time, so no startup-time native binding is required.
eachPackage('@deepseek-ai/dsh-attachment-local', 'lib/index.js', (file) => {
  let txt = read(file)
  let changed = false
  if (!txt.includes('DSH Android compat: attachment directory fsync')) {
    const anchor = 'const handle = await open(path, constants.O_RDONLY);'
    if (txt.includes(anchor)) {
      txt = txt.replace(anchor, `// DSH Android compat: attachment directory fsync may be rejected by Android mounts.\n\tlet handle;\n\ttry { handle = await open(path, constants.O_RDONLY); } catch (error) {\n\t\tif (error instanceof Error && 'code' in error && ['EPERM','EACCES','ENOTSUP'].includes(error.code)) return;\n\t\tthrow error;\n\t}`)
      changed = true
    }
  }
  // If current upstream still publishes the staged object via hard link, make
  // EPERM/EACCES recoverable without weakening EEXIST integrity checks.
  if (!txt.includes('DSH Android compat: attachment staged rename')) {
    const re = /await link\(staged\.path, target\);/
    if (re.test(txt)) {
      txt = txt.replace(re, `try {\n\t\t\tawait link(staged.path, target);\n\t\t} catch (androidLinkError) {\n\t\t\tif (!(androidLinkError instanceof Error && 'code' in androidLinkError && (androidLinkError.code === 'EPERM' || androidLinkError.code === 'EACCES'))) throw androidLinkError;\n\t\t\t// DSH Android compat: attachment staged rename.\n\t\t\tawait rename(staged.path, target);\n\t\t}`)
      txt = ensureFsPromisesImport(txt, ['rename'])
      // rename consumes staged.path; tolerate only the resulting ENOENT in the
      // cleanup that follows the original hard-link publication path.
      txt = txt.replace('await unlink(staged.path);', `await unlink(staged.path).catch((cleanupError) => {\n\t\t\tif (!(cleanupError instanceof Error && 'code' in cleanupError && cleanupError.code === 'ENOENT')) throw cleanupError;\n\t\t});`)
      changed = true
    }
  }
  // Immutable aliases cannot rename the content-addressed source.  On Android
  // copy it exclusively instead, preserving the original object.
  if (txt.includes('async function publishImmutableAlias(') && !txt.includes('DSH Android compat: publishImmutableAlias')) {
    const anchor = `\t\t\t/* v8 ignore next -- Private same-filesystem directories make EEXIST the only recoverable link race. */\n\t\t\tif (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;\n\t\t\tif (await digestFile(target) !== sha256) throw new AttachmentError("Stored attachment failed integrity verification.", "ATTACHMENT_CORRUPT");`
    if (txt.includes(anchor)) {
      const repl = `\t\t\t// DSH Android compat: publishImmutableAlias; hard links may be forbidden.\n\t\t\tif (error instanceof Error && "code" in error && (error.code === "EPERM" || error.code === "EACCES")) {\n\t\t\t\ttry { await copyFile(source, target, constants.COPYFILE_EXCL); } catch (copyError) {\n\t\t\t\t\tif (!(copyError instanceof Error && "code" in copyError && copyError.code === "EEXIST")) throw copyError;\n\t\t\t\t}\n\t\t\t} else if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;\n\t\t\tif (await digestFile(target) !== sha256) throw new AttachmentError("Stored attachment failed integrity verification.", "ATTACHMENT_CORRUPT");`
      txt = txt.replace(anchor, repl)
      txt = ensureFsPromisesImport(txt, ['copyFile'])
      changed = true
    } else warn(`attachment immutable-alias anchor changed: ${file}`)
  }
  if (androidStableStorageMandatory && !changed && !txt.includes('DSH Android compat:')) {
    throw new Error(`attachment Android storage compatibility patch missing: ${file}`)
  }
  if (changed) { write(file, txt); return 'patched' }
  return txt.includes('DSH Android compat:') ? 'already' : 'no-op'
}, { requiredIfPresent: androidStableStorageMandatory })

console.log(JSON.stringify({ prefix, targetVersion, patches: report }, null, 2))
