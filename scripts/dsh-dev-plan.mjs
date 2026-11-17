// P3 deterministic development plan orchestrator.
// Explicit plans only: no hidden model invocations or unattended background
// execution. Every completed or interrupted step is persisted atomically.
import {randomBytes,createHash} from 'node:crypto'
import {readFile,writeFile,rename,mkdir,readdir,realpath,lstat,open,rm,stat} from 'node:fs/promises'
import {resolve,join,sep,isAbsolute} from 'node:path'
import {homedir} from 'node:os'
import {acquirePathLocks} from './dsh-code-engine-journal.mjs'
import {workspaceCall} from './dsh-project-index.mjs'
import {projectBuildCall} from './dsh-project-build.mjs'
import {projectFileCall} from './dsh-workspace-files.mjs'
import {codeWorkflowCall} from './dsh-code-engine-workflow.mjs'
import {recoverTransactions} from './dsh-code-engine-journal.mjs'

const obj=(properties,required=[])=>({type:'object',properties,required,additionalProperties:false})
const str={type:'string'}
const stepSchema=obj({kind:{type:'string',enum:['detect','index','diagnostics','build','test','verify','edit','refactor','repair']},
 label:str,args:{type:'object'},when:{type:'string',enum:['always','onPreviousFailure','onPreviousSuccess']},
 onFailure:{type:'string',enum:['stop','continue']},maxAttempts:{type:'integer',minimum:1,maximum:3},
 dependsOn:{type:'array',maxItems:15,uniqueItems:true,items:{type:'integer',minimum:0,maximum:15}}},['kind'])
export const devPlanTools=[
 {name:'dev_plan_create',description:'Persist an explicit bounded engineering plan without executing steps. Supports conditional verification and supplied repair candidates.',inputSchema:obj({root:str,name:str,steps:{type:'array',minItems:1,maxItems:16,items:stepSchema}},['root','steps'])},
 {name:'dev_plan_run',description:'Execute up to 4 plan steps synchronously, checkpointing each result. Safe to call repeatedly; never runs in the background.',inputSchema:obj({id:str,maxSteps:{type:'integer',minimum:1,maximum:4},budgetMs:{type:'integer',minimum:1000,maximum:180000}},['id'])},
 {name:'dev_plan_status',description:'Get durable step statuses and compact errors without exposing persisted source-edit contents.',inputSchema:obj({id:str},['id'])},
 {name:'dev_plan_list',description:'List up to 50 stored engineering plans and progress.',inputSchema:obj({limit:{type:'integer',minimum:1,maximum:50}})},
 {name:'dev_plan_cancel',description:'Request cancellation, aborting an active build/test/verify process group and stopping other steps at the next boundary. Mutation journals remain protected.',inputSchema:obj({id:str},['id'])},
 {name:'dev_plan_resume',description:'Resume a paused or cancelled plan; failed steps require recovery and an explicit retry decision.',inputSchema:obj({id:str},['id'])},
 {name:'dev_plan_recover',description:'Inspect interrupted plan work and safely recover project transaction journals; resume only if source preimages match.',inputSchema:obj({id:str,restore:{type:'boolean'}} ,['id'])},
 {name:'dev_plan_report',description:'Summarize execution steps, failure causes, compact diagnostics and outstanding actions.',inputSchema:obj({id:str},['id'])},
]
export const isDevPlanTool=name=>devPlanTools.some(x=>x.name===name)
const KINDS=new Set(['detect','index','diagnostics','build','test','verify','edit','refactor','repair'])
const READONLY=new Set(['detect','index','diagnostics'])
const MUTATING=new Set(['edit','refactor','repair'])
const idCheck=id=>{if(typeof id!=='string'||!/^dp-[0-9a-f]{24}$/.test(id))throw Error('invalid development plan id');return id}
const storageRoot=()=>resolve(process.env.DSH_DEV_PLAN_DIR||join(process.env.HOME||homedir(),'.dsh','dev-plans'))
const filename=id=>join(storageRoot(),idCheck(id)+'.json')
const cancelledFile=id=>join(storageRoot(),idCheck(id)+'.cancel')
const hash=b=>createHash('sha256').update(b).digest('hex')
const now=()=>new Date().toISOString()
const inRoot=(path,root)=>path.startsWith(root+sep)
const clamp=(n,def,max)=>Number.isInteger(n)?Math.max(1,Math.min(max,n)):def
async function syncDir(dir){
 let fd
 try{fd=await open(dir,'r');await fd.sync()}
 catch(e){if(!['EISDIR','EINVAL','EACCES','EPERM','EOPNOTSUPP'].includes(e.code))throw e}
 finally{await fd?.close()}
}
async function durableJson(path,data,{exclusive=false}={}){
 const temp=path+'.'+randomBytes(8).toString('hex')+'.tmp'
 try{
  const fd=await open(temp,'wx',0o600)
  try{await fd.writeFile(JSON.stringify(data)+'\n');await fd.sync()}finally{await fd.close()}
  if(exclusive){
   // Destination must not overwrite a concurrently-created id.
   const {link,unlink}=await import('node:fs/promises')
   await link(temp,path);await unlink(temp)
  }else await rename(temp,path)
  await syncDir(storageRoot())
 }finally{await rm(temp,{force:true}).catch(()=>{})}
}
function smallResult(result){
 if(result===undefined)return null
 const compact=JSON.stringify(result)
 if(compact.length<=10000)return result
 return {truncated:true,summary:compact.slice(0,8500)}
}
async function rootPath(value){
 if(typeof value!=='string'||!value.trim()||value.includes('\0'))throw Error('project root required')
 const root=await realpath(resolve(value))
 const mode=await lstat(root)
 if(!mode.isDirectory())throw Error('project root must be a directory')
 return root
}
function projectFile(root,value){
 if(typeof value!=='string'||!value||value.includes('\0'))throw Error('invalid project file path')
 const normalized=isAbsolute(value)?resolve(value):resolve(root,value)
 if(!inRoot(normalized,root))throw Error('step file escapes project root: '+value)
 return normalized
}
function forbidKeys(a,allowed){
 for(const k of Object.keys(a))if(!allowed.includes(k))throw Error('unsupported plan step option: '+k)
}
function normalizedStep(root,input,i){
 if(!input||!KINDS.has(input.kind))throw Error('invalid step kind at '+i)
 const a=input.args||{}
 if(typeof a!=='object'||!a||Array.isArray(a))throw Error('step args must be a plain object')
 if(input.when&&!['always','onPreviousFailure','onPreviousSuccess'].includes(input.when))throw Error('invalid step condition')
 if(input.onFailure&&!['stop','continue'].includes(input.onFailure))throw Error('invalid failure policy')
 if(input.onFailure==='continue'&&MUTATING.has(input.kind))throw Error('mutating step may not silently continue after failure')
 const maxAttempts=clamp(input.maxAttempts,1,3)
 if(maxAttempts>1&&MUTATING.has(input.kind))throw Error('mutating steps cannot automatically retry')
 const allowed={
  detect:[],index:['maxFiles','force'],diagnostics:['file','limit'],
  build:['system','target','args','timeoutMs'],test:['system','args','timeoutMs'],
  verify:['system','runTests','timeoutMs'],
  edit:['system','edits','runTests','timeoutMs','lockTimeoutMs'],
  refactor:['system','operations','verify','runTests','timeoutMs','lockTimeoutMs'],
  repair:['system','candidates','runTests','timeoutMs','lockTimeoutMs']
 }
 forbidKeys(a,allowed[input.kind])
 if(JSON.stringify(a).length>60000)throw Error('single step arguments exceed 60 KiB')
 if(a.file!==undefined)projectFile(root,a.file)
 const verifyTarget=(v)=>{const full=projectFile(root,v);return full}
 if(input.kind==='edit'){
  if(!Array.isArray(a.edits)||a.edits.length<1||a.edits.length>32)throw Error('edit requires 1..32 source edits')
  for(const edit of a.edits)verifyTarget(edit.path)
 }
 if(input.kind==='refactor'){
  if(!Array.isArray(a.operations)||a.operations.length<1||a.operations.length>24)throw Error('refactor requires 1..24 file operations')
  for(const op of a.operations){verifyTarget(op.path);if(op.to!==undefined)verifyTarget(op.to)}
 }
 if(input.kind==='repair'){
  if(!Array.isArray(a.candidates)||a.candidates.length<1||a.candidates.length>6)throw Error('repair requires 1..6 explicit candidates')
  for(const candidate of a.candidates){
   if(!Array.isArray(candidate.edits)||candidate.edits.length<1||candidate.edits.length>32)throw Error('candidate edits must contain 1..32 files')
   for(const edit of candidate.edits)verifyTarget(edit.path)
  }
 }
 return {kind:input.kind,label:String(input.label||input.kind).slice(0,120),
  sourceIndex:i,dependsOn:[],args:a,when:input.when||'always',onFailure:input.onFailure||'stop',maxAttempts,
  status:'pending',attempts:0,result:null,startedAt:null,finishedAt:null}
}
async function load(id){
 const state=JSON.parse(await readFile(filename(id),'utf8'))
 if(state.version!==1||state.id!==id||!Array.isArray(state.steps))throw Error('unsupported or corrupt development plan')
 return state
}
const view=state=>({id:state.id,name:state.name,root:state.root,status:state.status,createdAt:state.createdAt,
 updatedAt:state.updatedAt,cursor:state.cursor,total:state.steps.length,interrupted:state.status==='running',
 steps:state.steps.map((s,i)=>({index:i,sourceIndex:s.sourceIndex??i,kind:s.kind,label:s.label,
  dependsOn:(s.dependsOn||[]).map(d=>state.steps[d]?.sourceIndex??d),status:s.status,attempts:s.attempts,
  startedAt:s.startedAt,finishedAt:s.finishedAt,result:s.result})),nextAction:state.nextAction||null})
async function save(state){state.updatedAt=now();await durableJson(filename(state.id),state)}
async function withLock(id,fn){
 const lock=await acquirePathLocks([filename(id)],{timeoutMs:15000,staleMs:1500})
 try{return await fn()}finally{await lock.release()}
}
async function create(args){
 const root=await rootPath(args.root)
 if(!Array.isArray(args.steps)||args.steps.length<1||args.steps.length>16)throw Error('plan requires 1..16 steps')
 // Dependencies refer to zero-based indices of the caller's original steps.
 // Stable topological sorting preserves legacy sequential order for plans
 // without dependencies and keeps the existing durable cursor/checkpoints.
 const original=args.steps.map((s,i)=>normalizedStep(root,s,i))
 for(const [i,input] of args.steps.entries()){
  const deps=input.dependsOn??[]
  if(!Array.isArray(deps)||deps.length>15||
   deps.some(d=>!Number.isInteger(d)||d<0||d>=original.length||d===i)||
   new Set(deps).size!==deps.length)throw Error('invalid plan dependencies at step '+i)
  original[i].dependsOn=deps
 }
 const remaining=new Set(original.map((_,i)=>i)),order=[]
 while(remaining.size){
  const next=[...remaining].find(i=>original[i].dependsOn.every(d=>!remaining.has(d)))
  if(next===undefined)throw Error('plan dependencies contain a cycle')
  order.push(next);remaining.delete(next)
 }
 const positions=new Map(order.map((originalIndex,orderedIndex)=>[originalIndex,orderedIndex]))
 const steps=order.map(i=>({...original[i],dependsOn:original[i].dependsOn.map(d=>positions.get(d))}))
 const jsonSize=Buffer.byteLength(JSON.stringify(steps))
 if(jsonSize>256*1024)throw Error('development plan exceeds 256 KiB')
 await mkdir(storageRoot(),{recursive:true,mode:0o700})
 const state={version:1,id:'dp-'+randomBytes(12).toString('hex'),name:String(args.name||'Engineering plan').slice(0,120),
  root,status:'ready',cursor:0,createdAt:now(),updatedAt:now(),nextAction:null,steps}
 await durableJson(filename(state.id),state,{exclusive:true})
 return view(state)
}
function targetPaths(root,step){
 const a=step.args||{}
 if(step.kind==='edit')return a.edits.map(e=>projectFile(root,e.path))
 if(step.kind==='refactor')return a.operations.flatMap(op=>[op.path,op.to].filter(Boolean).map(p=>projectFile(root,p)))
 if(step.kind==='repair')return a.candidates.flatMap(c=>c.edits.map(e=>projectFile(root,e.path)))
 return []
}
async function fingerprints(paths){
 const output=[]
 for(const path of [...new Set(paths)]){
  try{
   const meta=await lstat(path)
   if(meta.isSymbolicLink()||!meta.isFile())throw Error('unsafe source in plan preimage: '+path)
   if(meta.size>16*1024*1024)throw Error('plan source preimage too large')
   output.push({path,exists:true,sha256:hash(await readFile(path))})
  }catch(e){
   if(e.code==='ENOENT')output.push({path,exists:false,sha256:null})
   else throw e
  }
 }
 return output
}
async function sameFingerprints(preimage){
 const fresh=await fingerprints(preimage.map(x=>x.path))
 return fresh.every((value,i)=>value.exists===preimage[i].exists&&value.sha256===preimage[i].sha256)
}
async function execute(root,step,{signal}={}){
 const args={...step.args}
 switch(step.kind){
  case 'detect':return projectBuildCall('workspace_detect',{root})
  case 'index':return workspaceCall('workspace_index',{root,...args})
  case 'diagnostics':return workspaceCall('workspace_diagnostics',{root,...args})
  case 'build':return projectBuildCall('workspace_build',{root,...args},{signal})
  case 'test':return projectBuildCall('workspace_test',{root,...args},{signal})
  case 'verify':return projectBuildCall('workspace_verify',{root,...args},{signal})
  case 'edit':return codeWorkflowCall('workspace_edit_verify',{...args,root,
   edits:args.edits.map(e=>({...e,path:projectFile(root,e.path)}))},{signal})
  case 'refactor':return projectFileCall('workspace_refactor',{...args,root})
  case 'repair':{
   const attempts=[]
   for(const [i,candidate] of args.candidates.entries()){
    const response=await codeWorkflowCall('workspace_edit_verify',{root,system:args.system,
     edits:candidate.edits.map(e=>({...e,path:projectFile(root,e.path)})),
     runTests:args.runTests!==false,timeoutMs:args.timeoutMs,lockTimeoutMs:args.lockTimeoutMs},{signal})
    attempts.push({candidate:i,label:String(candidate.label||'candidate '+(i+1)).slice(0,100),
     ok:response.ok,phase:response.phase||null,verification:smallResult(response.verification||null),
     rollback:response.rollback?{ok:response.rollback.ok,conflicts:response.rollback.conflicts||[]}:null})
    if(response.ok)return {ok:true,selected:i,attempts}
    if(signal?.aborted||response.cancelled)return {ok:false,cancelled:true,rollback:response.rollback,attempts,
     nextAction:'Repair cancelled; source rollback was attempted. Inspect recovery state before resuming.'}
    if(response.rollback?.ok===false||response.phase==='recovery'||response.phase==='lock')
     return {ok:false,stoppedForConflict:true,attempts,
      nextAction:'Review unresolved transaction or source conflict before trying another repair.'}
   }
   return {ok:false,attempts,nextAction:'All supplied repair candidates failed; provide a new candidate plan.'}
  }
  default:throw Error('unsupported plan step kind')
 }
}
function isSuccess(step,result){
 if(step.kind==='detect')return true
 return result?.ok!==false && (step.kind!=='verify'||result?.ok===true) &&
  (!['build','test','edit','refactor','repair'].includes(step.kind)||result?.ok===true)
}
async function isCancelled(id){
 try{await stat(cancelledFile(id));return true}catch(e){if(e.code==='ENOENT')return false;throw e}
}
async function run(args){
 const id=idCheck(args.id),maxSteps=clamp(args.maxSteps,2,4)
 const budgetMs=Math.min(180000,Math.max(1000,args.budgetMs||120000))
 return withLock(id,async()=>{
  const state=await load(id)
  if(state.status==='running'||state.status==='needs_review')return {...view(state),nextAction:'Run dev_plan_recover before resuming an interrupted step.'}
  if(['completed','completed_with_failures','cancelled','failed'].includes(state.status))return view(state)
  const deadline=Date.now()+budgetMs
  let consumed=0
  while(state.cursor<state.steps.length&&consumed<maxSteps&&Date.now()<deadline){
   if(await isCancelled(id)){state.status='cancelled';state.nextAction='Use dev_plan_resume to continue after cancellation.';break}
   const step=state.steps[state.cursor]
   // A skipped/failed prerequisite never authorizes downstream execution.
   // Independent branches still run when a non-mutating failure is configured
   // onFailure:'continue'; no parallel source mutations are introduced.
   const blocked=(step.dependsOn||[]).filter(d=>state.steps[d]?.status!=='passed')
   if(blocked.length){
    step.status='skipped';step.finishedAt=now()
    step.result={ok:false,reason:'dependency_not_passed',
     blockedBy:blocked.map(d=>({sourceIndex:state.steps[d].sourceIndex??d,
      status:state.steps[d].status}))}
    state.cursor++;await save(state);consumed++;continue
   }
   const previous=state.cursor>0?state.steps[state.cursor-1].status:null
   const skip=(step.when==='onPreviousFailure'&&previous!=='failed')||
              (step.when==='onPreviousSuccess'&&previous!=='passed')
   if(skip){step.status='skipped';step.finishedAt=now();step.result={reason:'condition_not_met',when:step.when,previousStatus:previous};state.cursor++;await save(state);consumed++;continue}
   state.status='running';step.status='running';step.startedAt=now();step.attempts++
   state.inflight={index:state.cursor,kind:step.kind,
    preimage:MUTATING.has(step.kind)?await fingerprints(targetPaths(state.root,step)):[]}
   await save(state)
   let result,exception
   // Only non-mutating build/test/verify calls are asynchronously cancellable.
   // Cancelling an edit here could interrupt its rollback journal halfway.
   // For mutations, signal only interrupts verification commands; the edit
   // transaction must finish rollback before the step may be cancelled.
   const cancellable=['build','test','verify','edit','repair'].includes(step.kind)
   const controller=cancellable?new AbortController():null
   let checking=false
   const watcher=controller?setInterval(async()=>{
    if(checking||controller.signal.aborted)return
    checking=true
    try{if(await isCancelled(id))controller.abort()}catch{}
    finally{checking=false}
   },100):null
   watcher?.unref?.()
   try{
    if(controller&&await isCancelled(id))controller.abort()
    result=await execute(state.root,step,{signal:controller?.signal})
   }catch(e){exception=String(e.message||e).slice(0,1200)}
   finally{if(watcher)clearInterval(watcher)}
   if(controller?.signal.aborted||result?.cancelled||result?.steps?.some(x=>x.cancelled)){
    const mutation=MUTATING.has(step.kind)
    const rollback=result?.rollback?.ok===true
    const unresolved=mutation&&!rollback
    step.result=smallResult({ok:false,cancelled:true,partial:result||null,rollback:result?.rollback})
    step.status=unresolved?'failed':'pending';step.finishedAt=now()
    if(unresolved){
     state.status='needs_review'
     state.nextAction='Cancellation interrupted a mutation without proven rollback; recover the source journal before replay.'
     // Keep the preimage and inflight marker for crash-aware recovery.
    }else{
     state.inflight=null;state.status='cancelled'
     state.nextAction='Active command was cancelled and sources are safe; inspect results before resuming.'
    }
    await save(state);break
   }
   const ok=!exception&&isSuccess(step,result)
   step.result=exception?{ok:false,error:exception}:smallResult(result)
   step.status=ok?'passed':'failed';step.finishedAt=now();state.inflight=null
   if(!ok&&step.attempts<step.maxAttempts){
    step.status='pending';state.status='paused';state.nextAction='Retry the failed read-only/build step with dev_plan_run.'
    await save(state);break
   }
   state.cursor++;consumed++
   if(!ok&&step.onFailure!=='continue'){
    state.status='failed'
    state.nextAction='Inspect dev_plan_report; use dev_plan_resume to retry after addressing the failure.'
    await save(state);break
   }
   state.status='paused';state.nextAction=null
   await save(state)
  }
  if(state.cursor>=state.steps.length){
   state.status=state.steps.some(s=>s.status==='failed'||s.result?.reason==='dependency_not_passed')?'completed_with_failures':'completed'
   state.nextAction=state.status==='completed_with_failures'?
    'A step failed but was configured to continue; review the report.':null
  }else if(state.status==='running'){state.status='paused';state.nextAction='Call dev_plan_run to continue from the next pending step.'}
  if(state.status==='paused'&&!state.nextAction)state.nextAction='Call dev_plan_run to continue.'
  await save(state)
  return view(state)
 })
}
async function recovery(args){
 const id=idCheck(args.id)
 return withLock(id,async()=>{
  const state=await load(id),inflight=state.inflight
  if(state.status!=='running'&&state.status!=='needs_review'&&!inflight)
   return {...view(state),recovery:{needed:false}}
  if(!inflight||!state.steps[inflight.index]){
   state.status='needs_review';state.nextAction='Plan checkpoint is incomplete: inspect project files manually.'
   await save(state);return {...view(state),recovery:{ok:false,reason:'missing checkpoint'}}
  }
  const step=state.steps[inflight.index]
  const restoring=args.restore===true
  if(!MUTATING.has(step.kind)){
   step.status='pending';state.status='paused';state.nextAction='Interrupted non-source step can be executed again.'
   state.inflight=null;await save(state)
   return {...view(state),recovery:{ok:true,kind:'safe-retry'}}
  }
  const changesBefore=await sameFingerprints(inflight.preimage)
  if(changesBefore){
   // A stale source journal may still contain pending records; users must
   // reconcile them before replaying a mutation.
   const pending=step.kind==='refactor'?
    await projectFileCall('workspace_refactor_recover',{root:state.root,dryRun:true}):
    await recoverTransactions({onlyPaths:targetPaths(state.root,step),dryRun:true})
   const conflicts=(pending.transactions||pending.results||[]).filter(x=>
    !['verified-committed-cleaned','rolled-back-cleaned','incomplete-prepare-discarded'].includes(x.status))
   if(!conflicts.length){
    step.status='pending';state.status='paused';state.inflight=null
    state.nextAction='Source preimages match; interrupted edit can be retried safely.'
    await save(state);return {...view(state),recovery:{ok:true,kind:'unchanged-preimage',pending}}
   }
  }
  let journal
  try{
   journal=step.kind==='refactor'?
    await projectFileCall('workspace_refactor_recover',{root:state.root,dryRun:!restoring}):
    await recoverTransactions({onlyPaths:targetPaths(state.root,step),dryRun:!restoring,lockStaleMs:1500})
  }catch(e){journal={ok:false,error:String(e.message||e)}}
  const restored=await sameFingerprints(inflight.preimage)
  const entries=journal?.results||journal?.transactions||[]
  const acceptable=new Set(['recovered','rolled-back-cleaned','verified-committed-cleaned',
   'incomplete-prepare-discarded','committed','already-recovered'])
  const journalSafe=journal&&journal.ok!==false&&entries.every(item=>acceptable.has(item.status))
  if(restoring&&restored&&journalSafe){
   step.status='pending';state.status='paused';state.inflight=null
   state.nextAction='Journal recovery restored original sources; dev_plan_run may retry.'
   await save(state);return {...view(state),recovery:{ok:true,restored:true,journal}}
  }
  state.status='needs_review'
  state.nextAction='Source state is ambiguous or changed. Review journal and files; do not automatically replay mutation.'
  await save(state)
  return {...view(state),recovery:{ok:false,restored,needsReview:true,journal}}
 })
}
async function resume(args){
 const id=idCheck(args.id)
 return withLock(id,async()=>{
  const state=await load(id)
  if(['running','needs_review'].includes(state.status)||state.inflight)
   throw Error('resolve or recover interrupted plan before resuming')
  if(['completed','completed_with_failures'].includes(state.status))return view(state)
  if(state.status==='failed'){
   // A terminal failure had already advanced the cursor. Retrying requires
   // deliberate choice; P2 transactions already handled source rollback.
   const prior=state.steps[state.cursor-1]
   if(!prior||(MUTATING.has(prior.kind)&&prior.result?.rollback?.ok!==true))
    throw Error('failed mutating step has unresolved rollback conflict; inspect first')
   prior.status='pending';state.cursor--
  }
  await rm(cancelledFile(id),{force:true})
  state.status='paused';state.nextAction='Call dev_plan_run to continue execution.'
  await save(state);return view(state)
 })
}
async function cancel(args){
 const id=idCheck(args.id)
 await load(id)
 const fd=await open(cancelledFile(id),'w',0o600)
 try{await fd.writeFile(now());await fd.sync()}finally{await fd.close()}
 return {id,cancellationRequested:true,meaning:'Active build/test/verify commands receive AbortSignal; source edits stop at safe step boundaries.'}
}
async function list(args={}){
 let entries
 try{entries=await readdir(storageRoot())}catch(e){if(e.code==='ENOENT')return {plans:[]};throw e}
 const out=[]
 for(const file of entries.filter(f=>/^dp-[0-9a-f]{24}\.json$/.test(f)).slice(-250)){
  try{const state=await load(file.slice(0,-5))
   out.push({id:state.id,name:state.name,status:state.status,root:state.root,cursor:state.cursor,
    total:state.steps.length,updatedAt:state.updatedAt})}catch{}
 }
 out.sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt))
 return {plans:out.slice(0,clamp(args.limit,20,50)),truncated:entries.length>250}
}
// Structured, read-only failure triage. No patches are synthesized or applied.
// All suggested repair candidates remain explicit user/model-authored edits.
function classifyFailure(step){
 const r=step.result||{},v=r.verification||{}
 const first=(r.steps||v.results||[]).find(x=>x.ok===false)||{}
 const issue=(first.diagnostics||r.diagnostics||[]).find(x=>x.severity==='error')||null
 const text=[r.error,r.nextAction,v.nextAction,first.stderr,first.stdout,issue?.message]
  .filter(x=>typeof x==='string').join('\n').slice(0,16000)
 const has=(pattern)=>pattern.test(text)
 let category='unknown',suggestion='Inspect bounded stderr, exit code and the failing phase before supplying a correction.'
 if(r.rollback?.ok===false||r.stoppedForConflict||r.phase==='recovery'){
  category='rollback_conflict';suggestion='Inspect the conflicting source journal and files; do not retry mutations.'
 }else if(r.cancelled||first.cancelled){
  category='cancelled';suggestion='Review partial output and explicitly resume the plan if retry is appropriate.'
 }else if(r.timedOut||first.timedOut){
  category='timeout';suggestion='Check for a hung process or increase the bounded command timeout.'
 }else if(has(/ENOENT|not found|No such file|missing executable|not_on_path/i)){
  category='missing_tool';suggestion='Verify the project toolchain and Android linker bridge before retrying.'
 }else if(has(/permission denied|EACCES|SELinux|operation not permitted/i)){
  category='permission';suggestion='Inspect Android app UID permissions and linker routing; avoid disabling security checks.'
 }else if(has(/syntaxerror|unexpected token|invalid syntax|parse error/i)){
  category='syntax';suggestion='Correct the reported syntax issue and rerun verification.'
 }else if(has(/assertionerror|tests? failed|FAIL:|FAILED \(/i)){
  category='test_failure';suggestion='Inspect the failing test assertion and provide a targeted source edit candidate.'
 }else if(issue||first.exitCode!==undefined&&first.exitCode!==0||r.ok===false){
  category='build_or_test';suggestion='Review structured compiler diagnostics and submit a verified repair candidate.'
 }
 return {sourceIndex:step.sourceIndex??null,kind:step.kind,category,
  failedPhase:r.failedPhase||v.failedPhase||first.phase||r.phase||null,
  exitCode:Number.isInteger(first.exitCode)?first.exitCode:null,
  issue:issue?{file:issue.file||null,line:issue.line||null,column:issue.column||null,
   message:String(issue.message||'').slice(0,400)}:null,
  suggestedAction:suggestion,requiresExplicitRepair:true}
}
export async function devPlanCall(name,args={}){
 switch(name){
  case 'dev_plan_create':return create(args)
  case 'dev_plan_run':return run(args)
  case 'dev_plan_status':return view(await load(idCheck(args.id)))
  case 'dev_plan_list':return list(args)
  case 'dev_plan_cancel':return cancel(args)
  case 'dev_plan_resume':return resume(args)
  case 'dev_plan_recover':return recovery(args)
  case 'dev_plan_report':{
   const state=await load(idCheck(args.id))
   return {...view(state),report:{
    total:state.steps.length,passed:state.steps.filter(s=>s.status==='passed').length,
    failed:state.steps.filter(s=>s.status==='failed').length,
    skipped:state.steps.filter(s=>s.status==='skipped').length,
    blocked:state.steps.filter(s=>s.result?.reason==='dependency_not_passed').map(s=>({sourceIndex:s.sourceIndex??state.steps.indexOf(s),label:s.label,blockedBy:s.result.blockedBy})),
    pending:state.steps.filter(s=>['pending','running'].includes(s.status)).length,
    triage:state.steps.filter(s=>s.status==='failed').map(classifyFailure),
    issues:state.steps.filter(s=>s.status==='failed').map(s=>({kind:s.kind,label:s.label,
     diagnostic:s.result?.nextAction||s.result?.verification?.nextAction||
      s.result?.steps?.find(x=>x.ok===false)?.nextAction||s.result?.error||
      s.result?.failedPhase||s.result?.phase||'Step failed without structured diagnostics',
     rollback:s.result?.rollback?{ok:s.result.rollback.ok}:null})),
    completed:state.status==='completed',needsReview:state.status==='needs_review'}}
  }
  default:throw Error('unknown P3 plan tool: '+name)
 }
}
