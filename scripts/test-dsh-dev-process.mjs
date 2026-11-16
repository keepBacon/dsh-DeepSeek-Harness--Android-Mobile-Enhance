#!/usr/bin/env node
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { devLaunch, devRun } from './dsh-dev-process.mjs'

const root=await mkdtemp(join(tmpdir(),'dsh-p0-exec-'))
try{
 const ok=await devRun(process.execPath,['-e','console.log("P0_EXEC_OK")'],{cwd:root,timeoutMs:2000})
 assert.equal(ok.ok,true)
 assert.match(ok.stdout,/P0_EXEC_OK/)
 const fail=await devRun(process.execPath,['-e','process.exit(9)'],{cwd:root,timeoutMs:2000})
 assert.equal(fail.ok,false)
 assert.equal(fail.exitCode,9)
 const timed=await devRun(process.execPath,['-e','setInterval(()=>{},1000)'],{cwd:root,timeoutMs:150})
 assert.equal(timed.timedOut,true)
 const ac=new AbortController()
 const pending=devRun(process.execPath,['-e','setInterval(()=>{},1000)'],{cwd:root,timeoutMs:2000,signal:ac.signal})
 setTimeout(()=>ac.abort(),100)
 const cancelled=await pending
 assert.equal(cancelled.cancelled,true)
 assert.equal(cancelled.ok,false)
 const capped=await devRun(process.execPath,['-e','process.stdout.write("x".repeat(6000))'],{maxOutputBytes:1024})
 assert.equal(capped.truncated,true)
 assert.ok(Buffer.byteLength(capped.stdout)<=1024)
 const prefix=join(root,'usr')
 await mkdir(join(prefix,'bin'),{recursive:true})
 await mkdir(join(root,'workspace'))
 await writeFile(join(prefix,'bin','clang'),'ELF_PLACEHOLDER')
 await writeFile(join(root,'workspace','gradlew'),'#!/bin/sh\nexit 0\n')
 const env={...process.env,TERMUX__PREFIX:prefix,DSH_ANDROID_STANDALONE:'1',HOME:join(root,'home')}
 const launch=await devLaunch('clang',['--version'],{env,cwd:root})
 assert.equal(launch.command,'/system/bin/sh')
 assert.equal(launch.args[1],join(prefix,'bin','clang'))
 assert.deepEqual(launch.args.slice(2),['--version'])
 const wrapper=await devLaunch('./gradlew',['test'],{env,cwd:join(root,'workspace')})
 assert.equal(wrapper.command,'/system/bin/sh')
 assert.equal(wrapper.args[1],join(prefix,'bin','bash'))
 assert.deepEqual(wrapper.args.slice(2),[join(root,'workspace','gradlew'),'test'])
 await assert.rejects(devLaunch('not_a_command',['hello\0world'],{env}),/invalid argv/)
 console.log('[DSH] P0 Android/desktop development process runner: OK')
}finally{await rm(root,{recursive:true,force:true})}
