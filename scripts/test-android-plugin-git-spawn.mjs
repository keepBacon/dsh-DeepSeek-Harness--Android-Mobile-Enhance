#!/usr/bin/env node
// Ensure Node's pnpm/DSH child-process Git invocations are bridged on Android.
// Host CI validates exact command/argv routing, not physical Android execve.
import assert from 'node:assert/strict'
import {spawnSync} from 'node:child_process'
import {fileURLToPath} from 'node:url'
const preload=fileURLToPath(new URL('./dsh-android-plugin-git-spawn.cjs',import.meta.url))
const prefix='/data/data/com.dshmobile.shell/files/usr'
const testCode=`
const assert=require('node:assert/strict')
const cp=require('node:child_process')
const mod=require(process.argv[1])
const p=process.env.TERMUX__PREFIX
const shell='/system/bin/sh'
const expected=[p+'/libexec/dsh-mobile/android-exec.sh',p+'/bin/git']
for(const [name,args] of [
 ['git',['ls-remote','https://github.com/iJetLi/dsh-providers-hub.git','HEAD']],
 [p+'/bin/git',['--version']],
 [p+'/libexec/dsh/wrappers/git',['status']]
]){
 const routed=mod.adaptGitCommand(name,args)
 assert.equal(routed.command,shell)
 assert.deepEqual(routed.args,[...expected,...args])
}
assert.equal(mod.adaptGitCommand('node',['--version']),null)
assert.equal(mod.adaptGitCommand('github',['foo']),null)
assert.equal(mod.adaptGitCommand('/system/bin/git',['status']),null)
assert.equal(mod.adaptGitCommand(p+'/bin/git-extra',['status']),null)
assert.deepEqual(mod.adaptGitCommand('git',['arg with spaces',';echo unsafe']).args.slice(2),
 ['arg with spaces',';echo unsafe'])
// A true Node child-process call must fail trying the *system shell* on a
// non-Android runner, not a direct Git ENOENT.
const result=cp.spawnSync('git',['--version'],{encoding:'utf8'})
assert.equal(result.error?.path,shell)
;(async()=>{
 const named=await import('node:child_process')
 assert.equal(named.spawn,cp.spawn)
 assert.equal(named.spawnSync,cp.spawnSync)
 assert.equal(named.execFile,cp.execFile)
 assert.equal(named.execFileSync,cp.execFileSync)
 console.log('Git bridge: spawn/sync/execFile/ESM mapping OK')
})().catch(e=>{console.error(e);process.exitCode=1})
`
const base={...process.env,DSH_ANDROID_STANDALONE:'1',
 TERMUX__PREFIX:prefix,PREFIX:prefix}
const on=spawnSync(process.execPath,['-e',testCode,preload],{
 env:base,encoding:'utf8',timeout:12000})
assert.equal(on.status,0,on.stderr+'\n'+on.stdout)
assert.match(on.stdout,/Git bridge:/)
const off=spawnSync(process.execPath,['-e',`
const assert=require('node:assert/strict')
const m=require(process.argv[1])
assert.equal(m.adaptGitCommand('git',['version']),null)
`,preload],{env:{...base,DSH_ANDROID_STANDALONE:'0'},encoding:'utf8',timeout:12000})
assert.equal(off.status,0,off.stderr)
console.log('[DSH] Android pnpm Git child-process (spawn, execFile, ESM and argv) compatibility: OK')
