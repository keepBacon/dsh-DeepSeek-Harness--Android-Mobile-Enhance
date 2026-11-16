// P0 build/test job service. Tasks live within the active MCP process;
// statuses are written durably so a restarted MCP reports "interrupted" rather
// than inventing success. User workspaces and build outputs are never deleted.
import { randomBytes } from 'node:crypto'
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { devRun } from './dsh-dev-process.mjs'

const MAX_RUNNING=2, MAX_RECORDED=100, MAX_LOG=128*1024
const active=new Map()
const prefix=()=>process.env.DSH_DEV_TASK_DIR||join(process.env.HOME||homedir()||tmpdir(),'.dsh','dev-tasks')
const obj=(properties,required=[])=>({type:'object',properties,required,additionalProperties:false})
const str={type:'string'}
export const devTaskTools=[
 {name:'dev_task_start',description:'Start a bounded build/test command without shell interpretation; Android ELF bridge, output caps, cancellation and durable task status.',inputSchema:obj({command:str,args:{type:'array',maxItems:128,items:str},cwd:str,timeoutMs:{type:'integer',minimum:100,maximum:3600000}},['command'])},
 {name:'dev_task_status',description:'Read durable build/test task state and bounded output; stale running tasks are marked interrupted after service restart.',inputSchema:obj({id:str},['id'])},
 {name:'dev_task_cancel',description:'Cancel a running build/test job and its active process group.',inputSchema:obj({id:str},['id'])},
 {name:'dev_task_list',description:'List the most recent development jobs without modifying projects.',inputSchema:obj({limit:{type:'integer',minimum:1,maximum:100}},[])},
]
const registered=new Set(devTaskTools.map(x=>x.name))
export const isDevTaskTool=name=>registered.has(name)
function checkId(id){if(typeof id!=='string'||!/^dt-[a-f0-9]{24}$/.test(id))throw Error('invalid task id');return id}
function filename(id){return join(prefix(),checkId(id)+'.json')}
function publicState(state){const {pid,...rest}=state;return rest}
async function persist(state){
 const root=prefix();await mkdir(root,{recursive:true,mode:0o700})
 const dest=filename(state.id),tmp=dest+'.'+randomBytes(6).toString('hex')+'.tmp'
 await writeFile(tmp,JSON.stringify(state),{mode:0o600,flag:'wx'})
 await rename(tmp,dest)
}
async function getState(id){
 const state=JSON.parse(await readFile(filename(id),'utf8'))
 if(state.status==='running'&&!active.has(id)){
  state.status='interrupted'
  state.finishedAt=new Date().toISOString()
  state.error='MCP service restarted; previous process outcome is unknown'
  await persist(state)
 }
 return state
}
function capAppend(text,chunk){
 const combined=text+chunk
 if(Buffer.byteLength(combined)<=MAX_LOG)return combined
 // Keep the most recent 128 KiB, including compiler errors at the tail.
 return Buffer.from(combined).subarray(-MAX_LOG).toString('utf8')
}
async function start(a){
 if(typeof a.command!=='string'||!a.command.trim())throw Error('command required')
 if(a.args!==undefined&&(!Array.isArray(a.args)||a.args.length>128||a.args.some(x=>typeof x!=='string')))throw Error('invalid argv')
 if(active.size>=MAX_RUNNING)throw Error('development task concurrency limit reached')
 const root=prefix();await mkdir(root,{recursive:true,mode:0o700})
 const id='dt-'+randomBytes(12).toString('hex')
 const cwd=resolve(a.cwd||process.cwd())
 const state={id,command:a.command,args:a.args||[],cwd,status:'running',startedAt:new Date().toISOString(),finishedAt:null,
  timeoutMs:Math.max(100,Math.min(3600000,a.timeoutMs||300000)),stdout:'',stderr:'',exitCode:null,timedOut:false,cancelled:false}
 const controller=new AbortController()
 // Reserve slot before any asynchronous launch begins.
 active.set(id,{controller,state})
 try{await persist(state)}catch(e){active.delete(id);throw e}
 const promise=(async()=>{
  try{
   const result=await devRun(state.command,state.args,{cwd,timeoutMs:state.timeoutMs,maxOutputBytes:MAX_LOG,signal:controller.signal})
   state.stdout=capAppend(state.stdout,result.stdout)
   state.stderr=capAppend(state.stderr,result.stderr)
   state.status=result.cancelled?'cancelled':result.timedOut?'timed_out':result.ok?'passed':'failed'
   state.exitCode=result.exitCode
   state.timedOut=result.timedOut
   state.cancelled=result.cancelled
   state.durationMs=result.durationMs
   state.bridged=result.bridged
  }catch(error){
   state.status=controller.signal.aborted?'cancelled':'failed'
   state.error=String(error.message||error).slice(0,1000)
  }finally{
   state.finishedAt=new Date().toISOString()
   active.delete(id)
   await persist(state).catch(()=>{})
  }
 })()
 // Keep the rejection observed, never let one failed build crash the MCP server.
 void promise.catch(()=>{})
 return {id,status:state.status,cwd,command:state.command,startedAt:state.startedAt}
}
async function cancel(id){
 const record=active.get(checkId(id))
 if(!record)return {cancelled:false,state:publicState(await getState(id))}
 record.controller.abort()
 return {cancelled:true,id,status:'cancellation_requested'}
}
async function list(limit=20){
 const root=prefix()
 let names
 try{names=await readdir(root)}catch(e){if(e.code==='ENOENT')return {tasks:[]};throw e}
 const entries=names.filter(x=>/^dt-[a-f0-9]{24}\.json$/.test(x)).sort().reverse().slice(0,Math.max(1,Math.min(MAX_RECORDED,limit)))
 const states=[]
 for(const item of entries){try{states.push(publicState(await getState(item.slice(0,-5))))}catch{}}
 return {tasks:states.map(s=>({id:s.id,command:s.command,cwd:s.cwd,status:s.status,startedAt:s.startedAt,finishedAt:s.finishedAt,exitCode:s.exitCode}))}
}
export async function devTaskCall(name,args={}){
 switch(name){
  case 'dev_task_start':return start(args)
  case 'dev_task_status':return publicState(await getState(args.id))
  case 'dev_task_cancel':return cancel(args.id)
  case 'dev_task_list':return list(args.limit)
  default:throw Error('unknown developer task tool '+name)
 }
}
