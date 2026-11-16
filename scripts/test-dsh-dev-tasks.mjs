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
 assert.equal(devTaskTools.length,4)
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
 const list=await devTaskCall('dev_task_list',{})
 assert.ok(list.tasks.some(x=>x.id===job.id))
 await assert.rejects(devTaskCall('dev_task_status',{id:'../escape'}),/invalid task id/)
 console.log('[DSH] P0 durable development task start/status/cancel: OK')
}finally{await rm(dir,{recursive:true,force:true})}
