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

function esc(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
function row(source, id, provider) {
  const re = new RegExp('^\\s*- id: ' + esc(id) + '\\s*$[\\s\\S]*?^\\s+name: [\\\'"]?' + esc(provider) + '[\\\'"]?\\s*$', 'mu')
  return re.test(source)
}
function disabled(source, id) {
  const re = new RegExp('^\\s*- id: ' + esc(id) + '\\s*$[\\s\\S]*?^\\s+disabled: true\\s*$', 'mu')
  return re.test(source)
}
function validate(id, source, contract) {
  const errors=[]
  for (const pair of contract.rows) {
    if (!row(source, pair[0], pair[1])) errors.push(id + ': missing/mismatched ' + pair[0] + ' -> ' + pair[1])
  }
  for (const rowId of contract.disabled || []) {
    if (!disabled(source,rowId)) errors.push(id + ': expected disabled row ' + rowId)
  }
  if (id === 'standard' || id === 'ptc' || id === 'cordis') {
    if (!source.includes("- id: tool-bash\n  name: '@deepseek-ai/dsh-tool-bash'\n  disabled: !!js process.platform === 'win32'")) {
      errors.push(id + ': Bash platform gate changed')
    }
    if (!source.includes("- id: tool-pwsh\n  name: '@deepseek-ai/dsh-tool-pwsh'\n  disabled: !!js process.platform !== 'win32'")) {
      errors.push(id + ': PowerShell platform gate changed')
    }
  }
  if (id === 'minimal') {
    if (!source.includes("    - id: persistent-bash\n      name: '@deepseek-ai/dsh-tool-bash-persistent'\n      disabled: !!js process.platform === 'win32'")) {
      errors.push('minimal: persistent Bash POSIX gate changed')
    }
    if (!source.includes("    - id: persistent-pwsh\n      name: '@deepseek-ai/dsh-tool-pwsh-persistent'\n      disabled: !!js process.platform !== 'win32'")) {
      errors.push('minimal: persistent PowerShell Windows gate changed')
    }
  }
  if (errors.length) throw new Error(errors.join('\n'))
}
function selfTest() {
  const common = [
    "- id: tool-bash\n  name: '@deepseek-ai/dsh-tool-bash'\n  disabled: !!js process.platform === 'win32'",
    "- id: tool-pwsh\n  name: '@deepseek-ai/dsh-tool-pwsh'\n  disabled: !!js process.platform !== 'win32'",
  ]
  for (const id of ['standard','ptc','cordis']) {
    const c=contracts[id]
    const lines=[...common]
    for (const pair of c.rows) {
      if (pair[0] === 'tool-bash') continue
      lines.push('- id: ' + pair[0] + "\n  name: '" + pair[1] + "'" + ((c.disabled||[]).includes(pair[0]) ? '\n  disabled: true' : ''))
    }
    validate(id,lines.join('\n'),c)
  }
  const m=contracts.minimal
  const ml=[]
  for (const pair of m.rows) {
    let gate=''
    if (pair[0] === 'persistent-bash') gate="\n      disabled: !!js process.platform === 'win32'"
    if (pair[0] === 'persistent-pwsh') gate="\n      disabled: !!js process.platform !== 'win32'"
    ml.push("    - id: " + pair[0] + "\n      name: '" + pair[1] + "'" + gate)
  }
  validate('minimal',ml.join('\n'),m)
  console.log('[DSH] Agent preset tool parity validator self-test: OK')
}
const arg=process.argv[2]
if (arg === '--self-test') { selfTest(); process.exit(0) }
if (!arg) { console.error('usage: validate-agent-preset-parity.mjs <node_modules-dir>'); process.exit(2) }
const root=path.join(path.resolve(arg),'@deepseek-ai','dsh-agent-presets','presets')
if (!fs.isDirectorySync(root)) throw new Error('shipped Agent preset root missing: ' + root)
for (const id of Object.keys(contracts)) {
  const file=path.join(root,id,'agent.cordis.yml')
  if (!fs.isFileSync(file)) throw new Error('shipped Agent preset missing: ' + file)
  validate(id,fs.readFileSync(file,'utf8'),contracts[id])
}
console.log('[DSH] Agent preset tool parity: OK (standard/PTC/minimal/Cordis)')
