// Bounded, real process-launch probe for the Android app-UID. File presence
// and chmod are NEVER reported as successful execution. Each binary starts
// alone to respect constrained mobile memory. No side effects or installations.
import { stat, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { devRun } from './dsh-dev-process.mjs'

const CORE = Object.freeze([
  ['node',['--version']],
  ['python3',['--version']],
  ['git',['--version']],
  ['ssh',['-V']],
])
const EXTENDED = Object.freeze([
  ['clang',['--version']],
  ['qemu-x86_64',['--version']],
])
const LIMIT=4096
function cap(text){return String(text??'').slice(0,LIMIT)}
async function availableMemoryKiB(){
  try {
    const raw=await readFile('/proc/meminfo','utf8')
    const n=Number(raw.match(/^MemAvailable:\s+(\d+)\s+kB/m)?.[1])
    return Number.isFinite(n)&&n>=0?n:null
  }catch{return null}
}
export async function probeToolchain({extended=false,timeoutMs=4000,env=process.env,
  run=devRun, memory=availableMemoryKiB}={}) {
  const prefix=env.TERMUX__PREFIX||env.PREFIX||''
  const isAndroid=env.DSH_ANDROID_STANDALONE==='1' &&
    /^\/data\/(?:data|user\/\d+)\/[^/]+\/files\/usr\/?$/.test(prefix)
  const memoryKiB=await memory().catch(()=>null)
  const results=[]
  const list=extended?[...CORE,...EXTENDED]:CORE
  for(const [name,args] of list){
    const file=join(prefix,'bin',name)
    let present=false
    try{present=(await stat(file)).isFile()}catch{}
    if(!prefix||!present){
      results.push({name,installed:false,runnable:false,reason:'binary-not-found'})
      continue
    }
    // No concurrency; no running a model or another compiler inside a probe.
    // devRun uses /system/bin/sh -> linker64 on an actual Android app UID.
    try{
      const reply=await run(name,args,{env,timeoutMs:Math.min(8000,Math.max(1000,timeoutMs)),
        maxOutputBytes:4096})
      const runnable=reply.exitCode===0&&!reply.timedOut&&!reply.cancelled
      results.push({name,installed:true,runnable,
        exitCode:reply.exitCode??null,timedOut:!!reply.timedOut,cancelled:!!reply.cancelled,
        ...(runnable?{version:cap(reply.stdout||reply.stderr).split('\n')[0]}:
          {reason:reply.timedOut?'timeout':reply.cancelled?'cancelled':
            reply.exitCode===126?'loader-or-permission-denied':
            reply.exitCode===127?'missing-binary-or-library':'execution-failed',
            detail:cap(reply.stderr||reply.stdout).split('\n')[0]})})
    }catch(error){
      results.push({name,installed:true,runnable:false,reason:'spawn-error',
        detail:cap(error?.code||error?.message||'unknown').split('\n')[0]})
    }
  }
  return {platform:process.platform,androidAppUid:isAndroid,prefix:prefix||null,
    memoryAvailableKiB:memoryKiB,
    memoryNote:'MemAvailable is system-wide, not the Android app memory quota',
    probes:results,verifiedRunnable:results.filter(x=>x.runnable).map(x=>x.name),
    cloudRecommended:results.some(x=>x.installed&&!x.runnable) ||
      (memoryKiB!=null&&memoryKiB<512*1024),
    note:'Only an exitCode=0 from the actual child process counts as runnable. '+ 
      'A mounted file, executable bit or command -v is not proof of Android ELF compatibility.'}
}
