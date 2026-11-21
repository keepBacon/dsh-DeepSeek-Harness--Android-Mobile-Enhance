#!/usr/bin/env node
import assert from 'node:assert/strict'
import {mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
const dir=await mkdtemp(join(tmpdir(),'dsh-p0-tasks-'))
process.env.DSH_DEV_TASK_DIR=dir
const {devTaskCall,devTaskTools}=await import('./dsh-dev-tasks.mjs')
async function finished(id){
 for(let i=0;i<100;i++){
  const s=await devTaskCall('dev_task_status',{id})
  if(s.status!=='running')return s
  await new Promise(r=>setTimeout(r,30))
 }
 throw Error('task failed to complete')
}
try{
 assert.equal(devTaskTools.length,5)
 assert.ok(devTaskTools.some(x=>x.name==='dev_toolchain_smoke'))
 const job=await devTaskCall('dev_task_start',{command:process.execPath,args:['-e','console.log("JOB_OK")']})
 assert.match(job.id,/^dt-[a-f0-9]{24}$/)
 const done=await finished(job.id)
 assert.equal(done.status,'passed')
 assert.equal(done.exitCode,0)
 assert.match(done.stdout,/JOB_OK/)
 const failing=await devTaskCall('dev_task_start',{command:process.execPath,args:['-e','process.exit(4)']})
 assert.equal((await finished(failing.id)).status,'failed')
 const sleep=await devTaskCall('dev_task_start',{command:process.execPath,args:['-e','setInterval(()=>{},1000)']})
 const cancelled=await devTaskCall('dev_task_cancel',{id:sleep.id})
 assert.equal(cancelled.cancelled,true)
 assert.equal((await finished(sleep.id)).status,'cancelled')
 // Concurrency slots are reserved only while a process is actually
 // running. A just-finished/cancelled task may remain in the active map
 // awaiting its final JSON write; it must not block a replacement launch.
 const occupied=[]
 for(let i=0;i<2;i++){
  occupied.push(await devTaskCall('dev_task_start',{command:process.execPath,
   args:['-e','setInterval(()=>{},1000)']}))
 }
 await assert.rejects(
  devTaskCall('dev_task_start',{command:process.execPath,args:['--version']}),
  /development task concurrency limit reached/
 )
 const release=await devTaskCall('dev_task_cancel',{id:occupied[0].id})
 assert.equal(release.cancelled,true)
 assert.equal((await finished(occupied[0].id)).status,'cancelled')
 const replacement=await devTaskCall('dev_task_start',{command:process.execPath,
  args:['-e','console.log("SLOT_REUSED")']})
 assert.equal((await finished(replacement.id)).status,'passed')
 await devTaskCall('dev_task_cancel',{id:occupied[1].id})
 assert.equal((await finished(occupied[1].id)).status,'cancelled')
 // Build logs must be queryable while a long process is still running.
 const streaming=await devTaskCall('dev_task_start',{command:process.execPath,
   args:['-e','process.stdout.write("LIVE_START");setTimeout(()=>{console.log("LIVE_END")},700)']})
 let observed=false
 for(let attempt=0;attempt<45;attempt++){
  const result=await devTaskCall('dev_task_status',{id:streaming.id})
  if(result.stdout.includes('LIVE_START')&&result.status==='running'){observed=true;break}
  await new Promise(resolve=>setTimeout(resolve,15))
 }
 assert.equal(observed,true,'stdout must be visible before process completion')
 const streamed=await finished(streaming.id)
 assert.equal(streamed.status,'passed')
 assert.match(streamed.stdout,/LIVE_END/)
 // The final compiler/linker diagnostic is at the *end* of a long output.
 const noisy=await devTaskCall('dev_task_start',{command:process.execPath,
   args:['-e','process.stdout.write("x".repeat(180000));process.stderr.write("FATAL_AT_END");process.exit(2)']})
 const noisyDone=await finished(noisy.id)
 assert.equal(noisyDone.status,'failed')
 assert.equal(noisyDone.truncated,true)
 assert.match(noisyDone.stderr,/FATAL_AT_END/)
 assert.ok(Buffer.byteLength(noisyDone.stdout)<=131072)
 const list=await devTaskCall('dev_task_list',{})
 assert.ok(list.tasks.some(x=>x.id===job.id))
 const ordered=[...list.tasks].sort((a,b)=>b.startedAt.localeCompare(a.startedAt)||b.id.localeCompare(a.id))
 assert.deepEqual(list.tasks,ordered,'tasks must sort by timestamp, not random ID')
 await assert.rejects(devTaskCall('dev_task_status',{id:'../escape'}),/invalid task id/)
 console.log('[DSH] P0 durable development task start/status/cancel: OK')
}finally{await rm(dir,{recursive:true,force:true})}
