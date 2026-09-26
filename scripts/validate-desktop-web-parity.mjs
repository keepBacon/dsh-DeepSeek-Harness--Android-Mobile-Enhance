#!/usr/bin/env node
/**
 * Validate that the Android runtime still carries the same default DSH Web
 * capability composition as the pinned desktop/CLI release family.
 *
 * This is intentionally a composition contract, not a second implementation
 * of DSH. The Android app boots the upstream Web profile; this guard catches
 * accidental package/profile drift before an APK can be packaged.
 */
import fs from 'node:fs'

const REQUIRED_ROWS = new Map([
  ['jobs', '@deepseek-ai/dsh-jobs-local'],
  ['subprocess', '@deepseek-ai/dsh-subprocess-local'],
  ['sandbox', '@deepseek-ai/dsh-sandbox-local'],
  ['sandbox-policy', '@deepseek-ai/dsh-sandbox-policy'],
  ['bash-sandbox', '@deepseek-ai/dsh-bash-sandbox'],
  ['pwsh-sandbox', '@deepseek-ai/dsh-pwsh-sandbox'],
  ['approval', '@deepseek-ai/dsh-user-approval'],
  ['permission', '@deepseek-ai/dsh-permission-presets'],
  ['shell-env', '@deepseek-ai/dsh-shell-env'],
  ['tool-bash', '@deepseek-ai/dsh-tool-bash'],
  ['tool-pwsh', '@deepseek-ai/dsh-tool-pwsh'],
  ['tool-jobs', '@deepseek-ai/dsh-tool-jobs'],
  ['tool-fs', '@deepseek-ai/dsh-tool-fs'],
  ['tool-fs-search', '@deepseek-ai/dsh-tool-fs-search'],
  ['skill', '@deepseek-ai/dsh-skill'],
  ['skill-filesystem', '@deepseek-ai/dsh-skill-filesystem'],
  ['tool-skill', '@deepseek-ai/dsh-tool-skill'],
  ['subagent', '@deepseek-ai/dsh-subagent'],
  ['subagent-spawn-in-process', '@deepseek-ai/dsh-subagent-spawn-in-process'],
  ['subagent-fork-in-process', '@deepseek-ai/dsh-subagent-fork-in-process'],
  ['tool-subagent-control', '@deepseek-ai/dsh-tool-subagent-control'],
  ['tool-subagent-list-agents', '@deepseek-ai/dsh-tool-subagent-control/list-agents'],
  ['tool-subagent', '@deepseek-ai/dsh-tool-subagent'],
  ['workflow-worker-thread', '@deepseek-ai/dsh-workflow-worker-thread'],
  ['tool-workflow', '@deepseek-ai/dsh-tool-workflow'],
  ['web', '@deepseek-ai/dsh-web'],
  ['web-fetch-http', '@deepseek-ai/dsh-web-fetch-http'],
  ['tool-web', '@deepseek-ai/dsh-tool-web'],
  ['tools', '@deepseek-ai/dsh-tools'],
  ['fs-sandbox', '@deepseek-ai/dsh-fs-sandbox'],
  ['attachment-local', '@deepseek-ai/dsh-attachment-local'],
  ['session-query-sqlite', '@deepseek-ai/dsh-session-query-sqlite'],

  ['code-runtime', '@deepseek-ai/dsh-code-runtime-worker-thread'],
  ['session-log-download', '@deepseek-ai/dsh-session-log-export'],
  ['workspace', '@deepseek-ai/dsh-workspace'],
  ['session-reference', '@deepseek-ai/dsh-session-reference'],
  ['file-reference-local', '@deepseek-ai/dsh-file-reference-local'],
  ['directory-picker', '@deepseek-ai/dsh-host-directory-picker-auto'],
  ['plugin-inventory', '@deepseek-ai/dsh-host-plugin-inventory'],
  ['session-controller', '@deepseek-ai/dsh-api-session-controller'],
  ['workspace-files', '@deepseek-ai/dsh-api-workspace-files'],
  ['settings-controller', '@deepseek-ai/dsh-api-settings-controller'],
  ['workspace-controller', '@deepseek-ai/dsh-api-workspace-controller'],
  ['webserver', '@deepseek-ai/dsh-host-webserver'],
  ['modules', '@deepseek-ai/dsh-client-modules'],
  ['connection', '@deepseek-ai/dsh-client-connection'],
  ['file-upload', '@deepseek-ai/dsh-client-file-upload'],
  ['api-remotes', '@deepseek-ai/dsh-api-remotes'],
  ['ui-sidebar-files', '@deepseek-ai/dsh-client-ui-sidebar-files'],
  ['ui-settings', '@deepseek-ai/dsh-client-ui-settings'],
  ['ui-settings-plugin-inventory', '@deepseek-ai/dsh-client-ui-settings-plugin-inventory'],
  ['ui-attachment', '@deepseek-ai/dsh-client-ui-attachment'],
  ['ui-workflow-run', '@deepseek-ai/dsh-client-ui-workflow-run'],
  ['ui-workspace', '@deepseek-ai/dsh-client-ui-workspace'],
  ['ui-skill', '@deepseek-ai/dsh-client-ui-skill'],
  ['ui-subagent', '@deepseek-ai/dsh-client-ui-subagent'],
  ['ui-schedule', '@deepseek-ai/dsh-client-ui-schedule'],
  ['ui-jobs', '@deepseek-ai/dsh-client-ui-jobs'],
  ['ui-permission', '@deepseek-ai/dsh-client-ui-permission-presets'],
  ['ui-settings-plugins', '@deepseek-ai/dsh-client-ui-settings-plugins'],
  ['agent-presets', '@deepseek-ai/dsh-agent-presets'],
])

// The Web profile deliberately disables host-global model-facing tools.
// dsh-agent-presets owns the per-Agent tool composition. Treating these rows
// as "missing desktop functionality" and force-enabling them would duplicate
// tools and diverge from the official desktop Web profile.
const AGENT_SCOPED_DISABLED = new Set([
  'tool-bash',
  'tool-pwsh',
  'tool-jobs',
  'tool-fs',
  'tool-fs-search',
  'skill-filesystem',
  'tool-skill',
  'command-goal',
  'tool-goal',
  'plan-mode',
  'compaction-basic',
  'command-compact',
  'tool-result-pruner',
  'tool-subagent-control',
  'tool-subagent-list-agents',
  'tool-subagent',
  'tool-subagent-fork',
  'workflow-worker-thread',
  'tool-workflow',
  'tool-ralph',
  'agent-instructions',
  'tool-todo',
  'tool-web',
])

const scalar = (raw) => {
  const value = String(raw ?? '').trim()
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replace(/''/g, "'")
  }
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    try { return JSON.parse(value) } catch {}
  }
  return value
}

function parseTopLevelRows(source) {
  const rows = new Map()
  let current

  const commit = () => {
    if (current === undefined) return
    if (rows.has(current.id)) throw new Error('duplicate top-level config row: ' + current.id)
    rows.set(current.id, current)
  }

  for (const line of String(source).split(/\r?\n/u)) {
    const id = /^- id:\s*(.+?)\s*$/u.exec(line)
    if (id !== null) {
      commit()
      current = { id: scalar(id[1]) }
      continue
    }
    if (current === undefined) continue

    const name = /^  name:\s*(.+?)\s*$/u.exec(line)
    if (name !== null && current.name === undefined) {
      current.name = scalar(name[1])
      continue
    }
    const disabled = /^  disabled:\s*(.+?)\s*$/u.exec(line)
    if (disabled !== null && current.disabled === undefined) {
      current.disabled = scalar(disabled[1])
    }
  }
  commit()
  return rows
}

function validateContract(rows) {
  const errors = []

  for (const [id, expectedName] of REQUIRED_ROWS) {
    const row = rows.get(id)
    if (row === undefined) {
      errors.push('missing required desktop Web row: ' + id)
      continue
    }
    if (row.name !== expectedName) {
      errors.push(id + ': expected provider ' + expectedName + ', got ' + String(row.name))
    }
  }

  for (const id of AGENT_SCOPED_DISABLED) {
    const row = rows.get(id)
    if (row === undefined) {
      errors.push('missing Agent-scoped Web row: ' + id)
    } else if (row.disabled !== 'true') {
      errors.push(id + ': Web host row must stay disabled; agent-presets owns this tool (got disabled=' + String(row.disabled) + ')')
    }
  }

  const bashSandbox = rows.get('bash-sandbox')
  if (bashSandbox !== undefined
    && !/^!!js\s+process\.platform\s*===\s*['"]win32['"]$/u.test(bashSandbox.disabled ?? '')) {
    errors.push('bash-sandbox: expected Windows-only disable gate, got ' + String(bashSandbox.disabled))
  }

  const pwshSandbox = rows.get('pwsh-sandbox')
  if (pwshSandbox !== undefined
    && !/^!!js\s+process\.platform\s*!==\s*['"]win32['"]$/u.test(pwshSandbox.disabled ?? '')) {
    errors.push('pwsh-sandbox: expected non-Windows disable gate, got ' + String(pwshSandbox.disabled))
  }

  const schedule = rows.get('ui-schedule')
  if (schedule !== undefined && schedule.disabled !== 'true') {
    errors.push('ui-schedule: Schedule is an opt-in overlay in the official Web profile and must remain disabled by default')
  }

  const exempt = new Set([...AGENT_SCOPED_DISABLED, 'bash-sandbox', 'pwsh-sandbox', 'ui-schedule'])
  for (const id of REQUIRED_ROWS.keys()) {
    if (exempt.has(id)) continue
    const row = rows.get(id)
    if (row?.disabled === 'true') errors.push(id + ': required desktop Web capability is unexpectedly disabled')
  }

  if (errors.length > 0) {
    throw new Error('Desktop Web capability contract failed:\n' + errors.join('\n'))
  }
}

function selfTest() {
  const ids = new Set([...REQUIRED_ROWS.keys(), ...AGENT_SCOPED_DISABLED])
  const lines = []
  for (const id of ids) {
    const name = REQUIRED_ROWS.get(id) ?? '@self-test/' + id
    lines.push('- id: ' + id, "  name: '" + name + "'")
    if (AGENT_SCOPED_DISABLED.has(id) || id === 'ui-schedule') lines.push('  disabled: true')
    else if (id === 'bash-sandbox') lines.push("  disabled: !!js process.platform === 'win32'")
    else if (id === 'pwsh-sandbox') lines.push("  disabled: !!js process.platform !== 'win32'")
  }
  const source = lines.join('\n') + '\n'
  validateContract(parseTopLevelRows(source))

  const withoutWorkspace = source.replace(
    /- id: workspace\n  name: '@deepseek-ai\/dsh-workspace'\n/u,
    '',
  )
  let rejected = false
  try { validateContract(parseTopLevelRows(withoutWorkspace)) } catch { rejected = true }
  if (!rejected) throw new Error('self-test did not reject a missing workspace row')
  console.log('[DSH] Desktop Web capability validator self-test: OK')
}

const [input] = process.argv.slice(2)
if (input === '--self-test') {
  selfTest()
  process.exit(0)
}
if (!input) {
  console.error('usage: validate-desktop-web-parity.mjs <dsh-web-default-config-dump>')
  process.exit(2)
}

const rows = parseTopLevelRows(fs.readFileSync(input, 'utf8'))
validateContract(rows)
console.log(
  '[DSH] Desktop Web capability contract: OK ('
  + String(REQUIRED_ROWS.size) + ' critical rows; '
  + String(AGENT_SCOPED_DISABLED.size) + ' Agent-scoped tool rows; platform/opt-in gates preserved)',
)
