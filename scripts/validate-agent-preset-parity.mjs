#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'

const contracts = {
  standard: {
    rows: [
      ['tool-bash','@deepseek-ai/dsh-tool-bash'],
      ['tool-fs','@deepseek-ai/dsh-tool-fs'],
      ['tool-fs-search','@deepseek-ai/dsh-tool-fs-search'],
      ['tool-jobs','@deepseek-ai/dsh-tool-jobs'],
      ['skill-filesystem','@deepseek-ai/dsh-skill-filesystem'],
      ['tool-skill','@deepseek-ai/dsh-tool-skill'],
      ['command-goal','@deepseek-ai/dsh-command-goal'],
      ['tool-goal','@deepseek-ai/dsh-tool-goal'],
      ['plan-mode','@deepseek-ai/dsh-plan-mode'],
      ['compaction-basic','@deepseek-ai/dsh-compaction-basic'],
      ['tool-subagent','@deepseek-ai/dsh-tool-subagent'],
      ['tool-subagent-fork','@deepseek-ai/dsh-tool-subagent'],
      ['workflow-worker-thread','@deepseek-ai/dsh-workflow-worker-thread'],
      ['tool-workflow','@deepseek-ai/dsh-tool-workflow'],
      ['tool-ralph','@deepseek-ai/dsh-tool-ralph'],
      ['tool-ask-user','@deepseek-ai/dsh-tool-ask-user'],
      ['tool-todo','@deepseek-ai/dsh-tool-todo'],
      ['tool-web','@deepseek-ai/dsh-tool-web'],
      ['present','@deepseek-ai/dsh-tool-present'],
    ],
  },
  ptc: {
    rows: [
      ['tool-bash','@deepseek-ai/dsh-tool-bash'],
      ['tool-fs','@deepseek-ai/dsh-tool-fs'],
      ['tool-fs-search','@deepseek-ai/dsh-tool-fs-search'],
      ['tool-jobs','@deepseek-ai/dsh-tool-jobs'],
      ['skill-filesystem','@deepseek-ai/dsh-skill-filesystem'],
      ['tool-skill','@deepseek-ai/dsh-tool-skill'],
      ['tool-subagent','@deepseek-ai/dsh-tool-subagent'],
      ['workflow-worker-thread','@deepseek-ai/dsh-workflow-worker-thread'],
      ['tool-workflow','@deepseek-ai/dsh-tool-workflow'],
      ['tool-ask-user','@deepseek-ai/dsh-tool-ask-user'],
      ['tool-todo','@deepseek-ai/dsh-tool-todo'],
      ['tool-web','@deepseek-ai/dsh-tool-web'],
      ['tool-presentation','@deepseek-ai/dsh-agent-tool-presentation'],
      ['present','@deepseek-ai/dsh-tool-present'],
    ],
    disabled: ['tool-workflow'],
  },
  minimal: {
    rows: [
      ['pty','@deepseek-ai/dsh-terminal'],
      ['terminal-bash','@deepseek-ai/dsh-terminal-bash'],
      ['persistent-bash','@deepseek-ai/dsh-tool-bash-persistent'],
      ['terminal-pwsh','@deepseek-ai/dsh-terminal-bash'],
      ['persistent-pwsh','@deepseek-ai/dsh-tool-pwsh-persistent'],
    ],
  },
  cordis: {
    rows: [
      ['tool-bash','@deepseek-ai/dsh-tool-bash'],
      ['tool-fs','@deepseek-ai/dsh-tool-fs'],
      ['tool-fs-search','@deepseek-ai/dsh-tool-fs-search'],
      ['tool-jobs','@deepseek-ai/dsh-tool-jobs'],
      ['tool-subagent','@deepseek-ai/dsh-tool-subagent'],
      ['workflow-worker-thread','@deepseek-ai/dsh-workflow-worker-thread'],
      ['tool-workflow','@deepseek-ai/dsh-tool-workflow'],
      ['tool-ask-user','@deepseek-ai/dsh-tool-ask-user'],
      ['tool-todo','@deepseek-ai/dsh-tool-todo'],
      ['tool-web','@deepseek-ai/dsh-tool-web'],
      ['tool-cordis','@deepseek-ai/dsh-tool-cordis'],
      ['skill-filesystem','@deepseek-ai/dsh-skill-filesystem'],
      ['tool-skill','@deepseek-ai/dsh-tool-skill'],
      ['present','@deepseek-ai/dsh-tool-present'],
    ],
  },
}

function scalar(raw) {
  const value=String(raw || '').trim()
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1,-1).replace(/''/g,"'")
  }
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    try { return JSON.parse(value) } catch {}
  }
  return value
}

function parseRows(source) {
  const rows=new Map()
  let current
  for (const line of String(source).split(/\r?\n/u)) {
    const id=/^\s*- id:\s*(.+?)\s*$/u.exec(line)
    if (id) {
      current={id:scalar(id[1])}
      if (rows.has(current.id)) throw new Error('duplicate preset row: ' + current.id)
      rows.set(current.id,current)
      continue
    }
    if (!current) continue
    const name=/^\s+name:\s*(.+?)\s*$/u.exec(line)
    if (name && current.name === undefined) {
      current.name=scalar(name[1])
      continue
    }
    const disabled=/^\s+disabled:\s*(.+?)\s*$/u.exec(line)
    if (disabled && current.disabled === undefined) current.disabled=scalar(disabled[1])
  }
  return rows
}

function validate(id, source, contract) {
  const rows=parseRows(source)
  const errors=[]
  for (const [rowId,provider] of contract.rows) {
    const row=rows.get(rowId)
    if (!row) errors.push(id + ': missing row ' + rowId)
    else if (row.name !== provider) errors.push(id + ': ' + rowId + ' expected ' + provider + ', got ' + String(row.name))
  }
  for (const rowId of contract.disabled || []) {
    const row=rows.get(rowId)
    if (!row || row.disabled !== 'true') errors.push(id + ': expected disabled row ' + rowId)
  }
  if (id === 'standard' || id === 'ptc' || id === 'cordis') {
    if (rows.get('tool-bash')?.disabled !== "!!js process.platform === 'win32'") {
      errors.push(id + ': Bash platform gate changed')
    }
    if (rows.get('tool-pwsh')?.disabled !== "!!js process.platform !== 'win32'") {
      errors.push(id + ': PowerShell platform gate changed')
    }
  }
  if (id === 'minimal') {
    if (rows.get('persistent-bash')?.disabled !== "!!js process.platform === 'win32'") {
      errors.push('minimal: persistent Bash POSIX gate changed')
    }
    if (rows.get('persistent-pwsh')?.disabled !== "!!js process.platform !== 'win32'") {
      errors.push('minimal: persistent PowerShell Windows gate changed')
    }
  }
  if (errors.length) throw new Error(errors.join('\n'))
}

function makeSelfTest(id, contract) {
  const lines=[]
  for (const [rowId,provider] of contract.rows) {
    lines.push('- id: ' + rowId, "  name: '" + provider + "'")
    if ((contract.disabled || []).includes(rowId)) lines.push('  disabled: true')
    if ((id === 'standard' || id === 'ptc' || id === 'cordis') && rowId === 'tool-bash') {
      lines.push("  disabled: !!js process.platform === 'win32'")
    }
    if (id === 'minimal' && rowId === 'persistent-bash') {
      lines.push("  disabled: !!js process.platform === 'win32'")
    }
    if (id === 'minimal' && rowId === 'persistent-pwsh') {
      lines.push("  disabled: !!js process.platform !== 'win32'")
    }
  }
  if ((id === 'standard' || id === 'ptc' || id === 'cordis')
    && !contract.rows.some(([rowId]) => rowId === 'tool-pwsh')) {
    lines.push('- id: tool-pwsh',"  name: '@deepseek-ai/dsh-tool-pwsh'","  disabled: !!js process.platform !== 'win32'")
  }
  return lines.join('\n') + '\n'
}

function selfTest() {
  for (const [id,contract] of Object.entries(contracts)) validate(id,makeSelfTest(id,contract),contract)
  const broken=makeSelfTest('standard',contracts.standard).replace("- id: tool-fs\n  name: '@deepseek-ai/dsh-tool-fs'\n",'')
  let rejected=false
  try { validate('standard',broken,contracts.standard) } catch { rejected=true }
  if (!rejected) throw new Error('self-test failed to reject missing tool-fs')
  console.log('[DSH] Agent preset tool parity validator self-test: OK')
}

const arg=process.argv[2]
if (arg === '--self-test') { selfTest(); process.exit(0) }
if (!arg) { console.error('usage: validate-agent-preset-parity.mjs <node_modules-dir>'); process.exit(2) }

function isDirectory(target) {
  try { return fs.statSync(target).isDirectory() } catch { return false }
}
function isFile(target) {
  try { return fs.statSync(target).isFile() } catch { return false }
}

const root=path.join(path.resolve(arg),'@deepseek-ai','dsh-agent-presets','presets')
if (!isDirectory(root)) throw new Error('shipped Agent preset root missing: ' + root)
for (const [id,contract] of Object.entries(contracts)) {
  const file=path.join(root,id,'agent.cordis.yml')
  if (!isFile(file)) throw new Error('shipped Agent preset missing: ' + file)
  validate(id,fs.readFileSync(file,'utf8'),contract)
}
console.log('[DSH] Agent preset tool parity: OK (standard/PTC/minimal/Cordis)')
