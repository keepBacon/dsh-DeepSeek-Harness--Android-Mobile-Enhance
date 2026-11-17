#!/usr/bin/env node
// DSH P3 physical Android acceptance harness.
// Launch inside the DSH app UID / ARM64 Node runtime, from an installed
// source checkout. No authentication data is read or included in reports.
import {mkdtemp,writeFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join,dirname} from 'node:path'
import {fileURLToPath} from 'node:url'
import {devRun} from './dsh-dev-process.mjs'

const here=dirname(fileURLToPath(import.meta.url))
const android=process.platform==='android'||/^\/data\/(?:user\/\d+|data)\//.test(process.env.HOME||'')
if(!android){
 console.error('[DSH] This acceptance harness must run under the Android DSH app UID.')
 process.exitCode=2
}else{
 const started=Date.now(),baseline=process.memoryUsage().rss
 const report={schema:1,kind:'DSH-P3-physical-android-acceptance',timestamp:new Date().toISOString(),
  node:process.version,platform:process.platform,architecture:process.arch,
  appUid:process.getuid?.()??null,baselineRssBytes:baseline,cases:[],ok:false}
 const files=['test-dsh-workspace-lsp.mjs','test-dsh-dev-plan.mjs','test-dsh-p3-process-death.mjs']
 const cycles=Number.isInteger(Number(process.env.DSH_P3_ACCEPT_CYCLES))?
  Math.min(5,Math.max(1,Number(process.env.DSH_P3_ACCEPT_CYCLES))):2
 let all=true
 for(let cycle=1;cycle<=cycles;cycle++)for(const file of files){
  const invocation=await devRun(process.execPath,[join(here,file)],{
   cwd:dirname(here),timeoutMs:90000,maxOutputBytes:16384,captureTail:true})
  const item={cycle,test:file,ok:invocation.ok,exitCode:invocation.exitCode,
   timedOut:invocation.timedOut,cancelled:invocation.cancelled,durationMs:invocation.durationMs,
   output:(invocation.stdout+'\n'+invocation.stderr).slice(-1400)}
  report.cases.push(item)
  if(!item.ok){all=false;break}
 }
 report.durationMs=Date.now()-started
 report.endRssBytes=process.memoryUsage().rss
 report.ok=all&&report.cases.length===files.length*cycles
 report.limits=[
  'This is an app-UID execution/forced-process-death acceptance drill, not physical power-loss testing.',
  'Reported RSS measures the acceptance harness, not the entire Android application or its child processes.',
  'Long-lived game/foreground battery/performance measurements require separate device profiling.'
 ]
 const dest=process.env.DSH_P3_DEVICE_REPORT
 if(dest)await writeFile(dest,JSON.stringify(report,null,2)+'\n',{flag:'wx',mode:0o600})
 console.log(JSON.stringify(report,null,2))
 if(!report.ok)process.exitCode=1
}
