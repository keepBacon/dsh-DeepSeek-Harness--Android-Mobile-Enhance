#!/usr/bin/env node
// Verify command completion even when descendants keep the stdout/stderr
// pipe open after the direct child exits. Runs on ordinary GitHub Linux Node.
import assert from 'node:assert/strict'
import { boundedSpawn } from './dsh-bounded-spawn.mjs'

const ok=await boundedSpawn(process.execPath,['-e','process.stdout.write("READY");process.stderr.write("WARN")'],{timeoutMs:2000})
assert.equal(ok.exitCode,0)
assert.equal(ok.timedOut,false)
assert.equal(ok.stdout,'READY')
assert.equal(ok.stderr,'WARN')

const immediate=await boundedSpawn(process.execPath,['-e','process.exit(7)'],{timeoutMs:2000})
assert.equal(immediate.exitCode,7)
assert.equal(immediate.timedOut,false)

const missing=await boundedSpawn('/this-command-does-not-exist',[],{timeoutMs:2000})
assert.equal(missing.exitCode,null)
assert.match(missing.stderr,/ENOENT/)

const sleeping=await boundedSpawn(process.execPath,['-e','setInterval(()=>{},1000)'],{timeoutMs:200,maxOutputBytes:1024})
assert.equal(sleeping.timedOut,true)
assert.ok(sleeping.durationMs<1800,'hung process must not strand tool reply')

// Parent prints immediately and exits, but the grandchild still holds an
// inherited stdout pipe. A close-only implementation hangs for several
// seconds; boundedSpawn must finish soon after the parent's exit.
const inherited=await boundedSpawn(process.execPath,['-e',`
 const {spawn}=require('child_process');
 const child=spawn(process.execPath,['-e','setTimeout(()=>{},2500)'],{
   stdio:['ignore',process.stdout,process.stderr],detached:true
 });
 child.unref();
 console.log('PARENT_DONE')
`],{timeoutMs:1700})
assert.equal(inherited.exitCode,0)
assert.equal(inherited.timedOut,false)
assert.match(inherited.stdout,/PARENT_DONE/)
assert.ok(inherited.durationMs<1500,'must not await inherited grandchild pipe EOF')

const clipped=await boundedSpawn(process.execPath,['-e','process.stdout.write("x".repeat(4096))'],{timeoutMs:1000,maxOutputBytes:512})
assert.equal(clipped.exitCode,0)
assert.equal(clipped.truncated,true)
assert.equal(Buffer.byteLength(clipped.stdout),512)
console.log('[DSH] bounded MCP child lifecycle / timeout / orphaned pipe: OK')
