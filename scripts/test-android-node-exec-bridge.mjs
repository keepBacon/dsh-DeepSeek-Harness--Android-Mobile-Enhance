#!/usr/bin/env node
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { execFileSync, spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { join } from 'node:path'
const require = createRequire(import.meta.url)
const cp = require('node:child_process')
const mod = require('./android-node-exec-bridge.cjs')
assert.equal(mod.rewriteNodeInvocation('/usr/bin/node',['script.js'],'/usr/bin/node','/system/bin/linker64').command,'/system/bin/linker64')
assert.deepEqual(mod.rewriteNodeInvocation('git',['--version'],'/usr/bin/node','/system/bin/linker64'),{command:'git',args:['--version']})
const loader = ['/lib64/ld-linux-x86-64.so.2','/lib/x86_64-linux-gnu/ld-linux-x86-64.so.2'].find(existsSync)
if (loader && process.platform==='linux') {
  const node = process.execPath
  const dir = mkdtempSync(join(tmpdir(),'dsh-node-bridge-'))
  const cli = join(dir,'modsearch-fixture.js')
  writeFileSync(cli,'process.stdout.write("modsearch-cli-ok")')
  const session=mod.installNodeBridge({nodeBinary:node,linkerPath:loader,allow:true})
  try {
    assert.equal(process.execPath,node)
    assert.equal(cp.execFileSync(process.execPath,[cli],{encoding:'utf8'}),'modsearch-cli-ok')
    assert.equal(cp.spawnSync(process.execPath,['-p','2+3'],{encoding:'utf8'}).stdout.trim(),'5')
    assert.equal(execFileSync(process.execPath,['-p','8+1'],{encoding:'utf8'}).trim(),'9')
    assert.equal(spawnSync(process.execPath,['-p','3+3'],{encoding:'utf8'}).stdout.trim(),'6')
    assert.equal(cp.execFileSync('/bin/echo',['unrelated'],{encoding:'utf8'}).trim(),'unrelated')
    assert.equal(cp.spawnSync('/bin/echo',['normal'],{encoding:'utf8'}).stdout.trim(),'normal')
  } finally {
    session.restore()
    rmSync(dir,{recursive:true,force:true})
  }
  assert.equal(process.execPath,node)
} else {
  console.log('[DSH] dynamic-linker integration skipped (non-Linux or unavailable linker)')
}
console.log('[DSH] Android Node self-spawn linker bridge: OK')
