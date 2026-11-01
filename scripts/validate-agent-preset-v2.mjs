#!/usr/bin/env node
// DSH 0.2.x ships web profile definitions inside dsh-web-app as *.patch.yml.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

const root=resolve(process.argv[2]||'')
const version=process.argv[3]||'0.2.1-rc.5'
if(!process.argv[2])throw Error('usage: validate-agent-preset-v2.mjs <dsh-web-app-directory> [version]')
const pkg=JSON.parse(await readFile(join(root,'package.json'),'utf8'))
assert.equal(pkg.name,'@deepseek-ai/dsh-web-app')
assert.equal(pkg.version,version)
const required={
  standard:['tool-bash','tool-pwsh','tool-fs','tool-fs-search','tool-jobs','skill-filesystem','tool-skill','tool-subagent','tool-ask-user','tool-todo','tool-web','present'],
  ptc:['tool-bash','tool-pwsh','tool-fs','tool-fs-search','tool-jobs','skill-filesystem','tool-skill','tool-subagent','tool-workflow','tool-ask-user','tool-web','tool-presentation','present'],
  minimal:['pty','terminal-bash','persistent-bash','terminal-pwsh','persistent-pwsh'],
  cordis:['tool-bash','tool-pwsh','tool-fs','tool-fs-search','tool-jobs','tool-subagent','tool-workflow','tool-ask-user','tool-web','tool-cordis','skill-filesystem','tool-skill','present']
}
for(const [name,ids] of Object.entries(required)){
  const text=await readFile(join(root,'presets',name+'.patch.yml'),'utf8')
  assert.match(text,/^\s*- insert:\s*$/m)
  assert.match(text,new RegExp('id: preset-'+name+'(?:\\s|$)'))
  assert.match(text,/name:\s*['"]@deepseek-ai\/dsh-agent-preset['"]/)
  const rows=new Map()
  let current
  for(const line of text.split(/\r?\n/)){
    const id=/^\s*- id:\s*([\w-]+)\s*$/.exec(line)
    if(id){current=id[1];assert.ok(!rows.has(current),'duplicate preset id '+current);rows.set(current,{})}
    else if(current){
      const named=/^\s*name:\s*['"]?([^'"]+)['"]?\s*$/.exec(line)
      if(named&&!rows.get(current).name)rows.get(current).name=named[1]
      const disabled=/^\s*disabled:\s*(.+?)\s*$/.exec(line)
      if(disabled)rows.get(current).disabled=disabled[1]
    }
  }
  for(const id of ids){
    const entry=rows.get(id)
    assert.ok(entry,'preset '+name+' lacks '+id)
    assert.ok(entry.name?.startsWith('@deepseek-ai/dsh-'),'preset '+name+' bad provider for '+id)
  }
  if(name!=='minimal'){
    assert.equal(rows.get('tool-bash')?.disabled,"!!js process.platform === 'win32'")
    assert.equal(rows.get('tool-pwsh')?.disabled,"!!js process.platform !== 'win32'")
  }else{
    assert.equal(rows.get('persistent-bash')?.disabled,"!!js process.platform === 'win32'")
    assert.equal(rows.get('persistent-pwsh')?.disabled,"!!js process.platform !== 'win32'")
  }
  if(name==='ptc')assert.equal(rows.get('tool-workflow')?.disabled,'true')
}
console.log('[DSH] v0.2.x shipped web-app agent presets: OK ('+version+')')
