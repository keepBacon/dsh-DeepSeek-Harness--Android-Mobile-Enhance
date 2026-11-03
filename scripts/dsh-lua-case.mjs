// Durable offline investigations: immutable evidence, stage checkpoints and
// explicit retries. This is orchestration, not a persistent guest VM/session.
import { constants } from 'node:fs'
import { open, readFile, lstat, mkdir, realpath, rename, unlink, link } from 'node:fs/promises'
import { dirname, resolve, basename } from 'node:path'
import { randomBytes } from 'node:crypto'
import { TextDecoder } from 'node:util'
import { hash, identifier, summarizeTrace, compareTraces, liftTrace } from './dsh-lua-analysis-core.mjs'

const LIMIT = { tasks:64, scenarios:8, attempts:8, stateBytes:8*1024*1024, evidenceBytes:128*1024*1024, fileBytes:16*1024*1024 }
const str={type:'string'}, obj=(properties,required=[])=>({type:'object',properties,required,additionalProperties:false})
const integer=(minimum,maximum,def)=>({type:'integer',minimum,maximum,...(def===undefined?{}:{default:def})})
const optionsSchema=obj({
  hints:obj({pc:str,opcode:str,registers:str,instruction:str}), instrument:{type:'boolean'}, verifyInstrumentation:{type:'boolean',default:true},
  dispatcher:integer(0,15),probeOffset:integer(0,1048576),seed:integer(0,2147483647),timeoutMs:integer(250,15000),
  maxEvents:integer(16,2047),maxSteps:integer(1,100000),followCaptured:{type:'boolean',default:true},
  globals:{type:'object',additionalProperties:true},fixtures:obj({http:{type:'object',additionalProperties:str},services:{type:'object',additionalProperties:true}}),
})
export const luaCaseTools=[
 {name:'lua_case_create',description:'Create a NEW durable Lua/Luau investigation with immutable source evidence and up to eight input scenarios. Plans tasks without running guest code; existing directories are never overwritten.',inputSchema:obj({caseDir:str,source:str,path:str,expectedSha256:str,options:optionsSchema,scenarios:{type:'array',minItems:1,maxItems:8,items:obj({name:str,globals:{type:'object'},fixtures:{type:'object'},seed:integer(0,2147483647)},['name'])},maxDepth:integer(1,6,3)},['caseDir'])},
 {name:'lua_case_run',description:'Resume a durable case with stage checkpoints and a bounded task/time budget. Completed stages are reused after interruption; blocked tasks require explicit retry or changed overrides. Validates instrumentation against an uninstrumented baseline by default.',inputSchema:obj({caseDir:str,maxTasks:integer(1,8,2),wallTimeMs:integer(2000,120000,30000),maxDepth:integer(1,6),retryTaskIds:{type:'array',maxItems:64,items:str},taskOverrides:{type:'array',maxItems:64,items:obj({taskId:str,options:optionsSchema},['taskId','options'])}},['caseDir'])},
 {name:'lua_case_status',description:'Read task states, lineage, stage checkpoints and structured requirements from a saved case without executing code. Optionally hash-verify all referenced evidence.',inputSchema:obj({caseDir:str,verifyEvidence:{type:'boolean',default:false}},['caseDir'])},
 {name:'lua_case_compare',description:'Compare two saved input scenarios using verified source-matched task pairs, observed behavior, VM trace divergence and coverage union. Ambiguous/missing pairs and partial executions remain explicit; no guest code is run.',inputSchema:obj({caseDir:str,baselineScenario:str,candidateScenario:str,maxPairs:integer(1,16,8),saveReport:{type:'boolean',default:true}},['caseDir','baselineScenario','candidateScenario'])},
]
const own=(o,k)=>Object.hasOwn(o,k), now=()=>new Date().toISOString(), token=()=>randomBytes(12).toString('hex')
function bounded(v,def,min,max,name){if(v===undefined)return def;if(!Number.isInteger(v)||v<min||v>max)throw Error(name+' outside allowed range');return v}
function plain(v,name){if(!v||typeof v!=='object'||Array.isArray(v))throw Error(name+' must be an object');return v}
function canonical(v){if(Array.isArray(v))return v.map(canonical);if(v&&typeof v==='object')return Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])]));return v}
const digest=v=>hash(JSON.stringify(canonical(v)))
function checkedOptions(value,api){
  const v=value??{};plain(v,'options')
  for(const k of Object.keys(v))if(!own(optionsSchema.properties,k))throw Error('unknown case option: '+k)
  for(const k of ['instrument','verifyInstrumentation','followCaptured'])if(v[k]!==undefined&&typeof v[k]!=='boolean')throw Error(k+' must be a boolean')
  if(v.hints!==undefined){plain(v.hints,'hints');for(const [k,s]of Object.entries(v.hints)){if(!['pc','opcode','registers','instruction'].includes(k))throw Error('unknown role hint');identifier(s)}}
  if(v.probeOffset!==undefined)bounded(v.probeOffset,0,0,1048576,'probeOffset')
  api.runOptions(v)
  return structuredClone(v)
}
function merge(a,b){
  const out={...a,...b}
  if(a.globals||b.globals)out.globals={...a.globals,...b.globals}
  if(a.fixtures||b.fixtures){out.fixtures={...a.fixtures,...b.fixtures};for(const k of ['http','services'])if(a.fixtures?.[k]||b.fixtures?.[k])out.fixtures[k]={...a.fixtures?.[k],...b.fixtures?.[k]}}
  return out
}
async function bufferFile(path,max){
  const file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW)
  try{const s=await file.stat();if(!s.isFile()||s.size>max)throw Error('case file is not a bounded regular file');const data=Buffer.alloc(s.size+1);let n=0;while(n<data.length){const r=await file.read(data,n,data.length-n,n);if(!r.bytesRead)break;n+=r.bytesRead}if(n!==s.size)throw Error('case file changed during read');return data.subarray(0,n)}finally{await file.close()}
}
async function jsonFile(path,max=LIMIT.stateBytes){return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(await bufferFile(path,max)))}
async function synced(path,data){const f=await open(path,'wx',0o600);try{await f.writeFile(data);await f.sync()}finally{await f.close()}}
async function atomicState(root,state,lock=null){
  if(lock&&(await jsonFile(resolve(root,'.run.lock'),4096)).token!==lock.token)throw Error('case lock ownership changed')
  state.revision++;state.updatedAt=now()
  const data=JSON.stringify(state,null,2)+'\n';if(Buffer.byteLength(data)>LIMIT.stateBytes)throw Error('case state byte limit exceeded')
  const temp=resolve(root,'.state-'+token()+'.tmp')
  try{await synced(temp,data);await rename(temp,resolve(root,'case.json'))}finally{await unlink(temp).catch(e=>{if(e.code!=='ENOENT')throw e})}
}
function descriptor(record){
  if(!record||typeof record.file!=='string'||!(/^(?:sources\/[a-f0-9]{64}\.luau|attempts\/t\d{6}-\d{3}-(?:analysis|dynamic|baseline|result)\.json|reports\/[a-f0-9]{24}\.(?:json|md))$/).test(record.file)||!/^[a-f0-9]{64}$/.test(record.sha256)||!Number.isInteger(record.bytes)||record.bytes<0||record.bytes>LIMIT.fileBytes)throw Error('invalid case evidence descriptor')
  return record
}
async function evidence(root,record){
  descriptor(record);const parent=await lstat(resolve(root,dirname(record.file)));if(!parent.isDirectory()||parent.isSymbolicLink())throw Error('symlink/non-directory case evidence parent')
  const data=await bufferFile(resolve(root,record.file),LIMIT.fileBytes)
  if(data.length!==record.bytes||hash(data)!==record.sha256)throw Error('case evidence checksum mismatch: '+record.file)
  return data
}
async function evidenceJSON(root,record){return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(await evidence(root,record)))}
async function put(root,state,file,data){
  const bytes=Buffer.byteLength(data);if(bytes>LIMIT.fileBytes||state.evidenceBytes+bytes>LIMIT.evidenceBytes)throw Error('case evidence byte limit exceeded')
  const record={file,bytes,sha256:hash(data)};descriptor(record)
  const temp=resolve(root,dirname(file),'.new-'+token()+'.tmp')
  try{await synced(temp,data);await link(temp,resolve(root,file))}catch(error){if(error.code!=='EEXIST')throw error;await evidence(root,record)}finally{await unlink(temp).catch(e=>{if(e.code!=='ENOENT')throw e})}
  state.evidenceBytes+=bytes;return record
}
async function sourceObject(root,state,source){
  const sha=hash(source)
  if(state.sources[sha])await evidence(root,state.sources[sha]);else state.sources[sha]=await put(root,state,'sources/'+sha+'.luau',source)
  return sha
}
async function rootDirectory(path){
  if(typeof path!=='string'||!path||path.includes('\0'))throw Error('invalid caseDir')
  const requested=resolve(path),s=await lstat(requested)
  if(!s.isDirectory()||s.isSymbolicLink())throw Error('caseDir must be a real directory, not a symlink')
  const root=await realpath(requested)
  for(const name of ['sources','attempts','reports']){const s=await lstat(resolve(root,name));if(!s.isDirectory()||s.isSymbolicLink())throw Error('invalid case subdirectory: '+name)}
  return root
}
async function stateAt(root){
  const s=await jsonFile(resolve(root,'case.json'))
  if(s.schemaVersion!==1||!/^[a-f0-9]{24}$/.test(s.caseId)||!/^[a-f0-9]{64}$/.test(s.engineSha256)||!Number.isInteger(s.revision)||!Array.isArray(s.tasks)||s.tasks.length>LIMIT.tasks||!Array.isArray(s.scenarios)||s.scenarios.length<1||s.scenarios.length>LIMIT.scenarios||!s.sources||typeof s.sources!=='object'||!s.contexts||typeof s.contexts!=='object'||!Array.isArray(s.reports)||s.reports.length>64||!Number.isInteger(s.evidenceBytes)||s.evidenceBytes<0||s.evidenceBytes>LIMIT.evidenceBytes)throw Error('invalid case state')
  bounded(s.maxDepth,null,1,6,'maxDepth')
  const names=new Set(),ids=new Set()
  for(const sc of s.scenarios){if(typeof sc.name!=='string'||!/^[A-Za-z0-9_.-]{1,40}$/.test(sc.name)||names.has(sc.name))throw Error('invalid/duplicate scenario');names.add(sc.name)}
  for(const [sha,record]of Object.entries(s.sources)){descriptor(record);if(!/^[a-f0-9]{64}$/.test(sha)||record.sha256!==sha||record.file!=='sources/'+sha+'.luau')throw Error('invalid source descriptor')}
  for(const t of s.tasks){
    if(!/^t\d{6}$/.test(t.id)||ids.has(t.id)||!names.has(t.scenario)||!own(s.sources,t.sourceSha256)||!['pending','running','complete','blocked'].includes(t.state)||!Number.isInteger(t.depth)||t.depth<0||t.depth>6||!Array.isArray(t.attempts)||t.attempts.length>LIMIT.attempts)throw Error('invalid task state')
    ids.add(t.id)
    if(t.contextId&&(!own(s.contexts,t.contextId)||digest(s.contexts[t.contextId])!==t.contextId))throw Error('invalid inherited fixture context')
    for(const a of t.attempts){if(!Number.isInteger(a.number)||a.number<1||a.number>LIMIT.attempts||!['running','interrupted','complete','blocked'].includes(a.status))throw Error('invalid attempt state');for(const k of ['analysis','dynamic','baseline','result'])if(a[k]){descriptor(a[k]);if(!a[k].file.startsWith('attempts/'+t.id+'-'))throw Error('cross-task evidence reference')}}
  }
  for(const t of s.tasks)if(t.parentTaskId){const p=s.tasks.find(x=>x.id===t.parentTaskId);if(!p||p.depth+1!==t.depth||p.scenario!==t.scenario)throw Error('invalid task lineage')}
  return s
}
async function identity(pid){
  let boot=null,start=null
  try{boot=(await readFile('/proc/sys/kernel/random/boot_id','utf8')).trim();const stat=await readFile('/proc/'+pid+'/stat','utf8');start=stat.slice(stat.lastIndexOf(')')+2).split(' ')[19]}catch{}
  return {boot,start}
}
async function alive(owner){
  if(!Number.isInteger(owner?.pid)||owner.pid<1||typeof owner.token!=='string')throw Error('invalid case lock; inspect lock metadata')
  try{process.kill(owner.pid,0)}catch(e){if(e.code==='ESRCH')return false;if(e.code==='EPERM')return true;throw e}
  const id=await identity(owner.pid)
  return !(owner.boot&&id.boot&&owner.boot!==id.boot||owner.start&&id.start&&owner.start!==id.start)
}
async function acquire(root){
  const owner={pid:process.pid,token:token(),...await identity(process.pid)},path=resolve(root,'.run.lock')
  async function claim(){await synced(path,JSON.stringify(owner));return owner}
  try{return await claim()}catch(e){if(e.code!=='EEXIST')throw e}
  if(await alive(await jsonFile(path,4096)))throw Error('case is busy: another runner owns the lock')
  // Serialize stale-lock recovery so a second recovery cannot remove a newly
  // acquired runner lock. An interrupted recovery guard is reported, not stolen.
  const guard=resolve(root,'.recover.lock');await synced(guard,JSON.stringify(owner)).catch(e=>{if(e.code==='EEXIST')throw Error('case lock recovery is busy; inspect .recover.lock after interruption');throw e})
  try{const previous=await jsonFile(path,4096);if(await alive(previous))throw Error('case became busy');await unlink(path);return await claim()}finally{await unlink(guard)}
}
async function release(root,owner){try{if((await jsonFile(resolve(root,'.run.lock'),4096)).token===owner.token)await unlink(resolve(root,'.run.lock'))}catch(e){if(e.code!=='ENOENT')throw e}}
const requirement=(type,details={},blocking=true)=>({type,blocking,...details})
function requirements(run,analysis,trace,validation){
  const items=[]
  for(const event of run.events||[]){
    if(event.kind==='http_get'&&!event.fixture)items.push(requirement('supply-http-fixture',{url:event.url}))
    if(event.kind==='unsupported')items.push(requirement('unsupported-api',{api:event.api}))
    if(event.kind==='limit')items.push(requirement('review-limit',{reason:event.reason}))
  }
  if(run.phase==='capability')items.push(requirement('restore-luau-runtime',{error:run.error}))
  if(run.timedOut)items.push(requirement('review-timeout',{suggestion:'Inspect loop/fixtures before explicitly retrying or increasing limits.'}))
  if(!run.ok&&!items.length)items.push(requirement('inspect-execution-error',{phase:run.phase??'runtime',error:run.error??run.result}))
  if(validation?.equivalentObservedBehavior===false)items.push(requirement('instrumentation-divergence',{suggestion:'Review probe roles/offset, or retry with instrument:false. Captured descendants are not scheduled from this probe run.'}))
  if(validation?.performed&&validation.baselineCompleted===false)items.push(requirement('inspect-baseline-error',{suggestion:'The uninstrumented baseline did not finish; probe equivalence is unknown.'}))
  if(analysis.dispatchers.length&&!trace.steps)items.push(requirement('review-unobserved-dispatcher',{},false))
  if(analysis.diagnostics.length)items.push(requirement('review-static-diagnostics',{},false))
  return [...new Map(items.map(v=>[JSON.stringify(v),v])).values()].slice(0,24)
}
function behavior(run){
  return {ok:run.ok,result:run.result??null,error:run.error??null,phase:run.phase??null,
    events:(run.events||[]).filter(e=>!['vm_step','limit'].includes(e.kind)).map(e=>Object.fromEntries(Object.entries(e).filter(([k])=>!['seq','source','binaryBase64'].includes(k))))}
}
function validationOf(probed,baseline){
  const a=behavior(probed),b=behavior(baseline)
  const baselineCompleted=baseline.ok===true&&!baseline.partial
  return {performed:true,baselineCompleted,equivalentObservedBehavior:baselineCompleted?digest(a)===digest(b):null,
    resultEqual:digest({ok:a.ok,result:a.result,error:a.error})===digest({ok:b.ok,result:b.result,error:b.error}),
    apiEventsEqual:digest(a.events)===digest(b.events),scope:'observed output/API behavior for these fixtures only; not semantic equivalence'}
}
function summary(root,state,extra={}){
  const counts={pending:0,running:0,complete:0,blocked:0};for(const t of state.tasks)counts[t.state]++
  const runnable=state.tasks.filter(t=>t.state==='pending'&&t.depth<state.maxDepth).map(t=>t.id)
  const overall=counts.running?'running':runnable.length?'pending':counts.pending?'paused':counts.blocked?'blocked':'complete'
  const nextActions=state.tasks.flatMap(t=>[...(t.requirements||[]).map(r=>({taskId:t.id,...r})),...(t.state==='pending'&&t.depth>=state.maxDepth?[{taskId:t.id,...requirement('increase-max-depth',{depth:t.depth})}]:[])])
  return {schemaVersion:1,caseDir:root,caseId:state.caseId,revision:state.revision,overall,counts,runnableTaskIds:runnable,evidenceBytes:state.evidenceBytes,
    completeDevirtualization:false,tasks:state.tasks.map(t=>({id:t.id,scenario:t.scenario,parentTaskId:t.parentTaskId,sourceSha256:t.sourceSha256,depth:t.depth,state:t.state,
      attempts:t.attempts.map(a=>({number:a.number,status:a.status,phase:a.phase,analysis:a.analysis?.file,dynamic:a.dynamic?.file,baseline:a.baseline?.file,result:a.result?.file,reused:a.reused})),summary:t.summary??null})),nextActions,...extra}
}
function task(state,scenario,sha,parent=null,capture=null){
  if(state.tasks.length>=LIMIT.tasks)throw Error('case task limit reached')
  const t={id:'t'+String(state.tasks.length+1).padStart(6,'0'),scenario,sourceSha256:sha,parentTaskId:parent?.id??null,depth:parent?parent.depth+1:0,state:'pending',overrides:{},attempts:[],requirements:[],capture}
  state.tasks.push(t);return t
}
async function create(args,api){
  const input=await api.sourceInput(args),options=checkedOptions(args.options,api),maxDepth=bounded(args.maxDepth,3,1,6,'maxDepth')
  const scenarios=args.scenarios??[{name:'baseline'}]
  if(!Array.isArray(scenarios)||!scenarios.length||scenarios.length>LIMIT.scenarios)throw Error('scenarios must contain 1..8 inputs')
  const names=new Set(),prepared=scenarios.map(sc=>{
    plain(sc,'scenario');if(typeof sc.name!=='string'||!/^[A-Za-z0-9_.-]{1,40}$/.test(sc.name)||names.has(sc.name))throw Error('invalid/duplicate scenario name');names.add(sc.name)
    if(Object.keys(sc).some(k=>!['name','globals','fixtures','seed'].includes(k)))throw Error('unknown scenario property')
    const {name,...patch}=sc;checkedOptions(merge(options,patch),api);return {name,options:checkedOptions(patch,api)}
  })
  if(typeof args.caseDir!=='string'||!args.caseDir||args.caseDir.includes('\0'))throw Error('invalid caseDir')
  const requested=resolve(args.caseDir),root=resolve(await realpath(dirname(requested)),basename(requested))
  await mkdir(root,{mode:0o700})
  for(const name of ['sources','attempts','reports'])await mkdir(resolve(root,name),{mode:0o700})
  const state={schemaVersion:1,caseId:token(),engineSha256:await api.engineFingerprint(),revision:0,createdAt:now(),options,scenarios:prepared,maxDepth,sources:{},contexts:{},tasks:[],evidenceBytes:0,reports:[]}
  const sha=await sourceObject(root,state,input.text);for(const sc of prepared)task(state,sc.name,sha)
  await atomicState(root,state)
  return {status:'created',...summary(root,state),execution:'not-run'}
}
function taskOptions(state,t,api){
  const scenario=state.scenarios.find(s=>s.name===t.scenario)
  const options=merge(merge(merge(state.options,scenario.options),t.contextId?state.contexts[t.contextId]:{}),t.overrides)
  if(t.depth>0&&!own(t.overrides,'probeOffset'))delete options.probeOffset
  return checkedOptions(options,api)
}
async function stage(root,state,t,attempt,name,payload,owner){
  const file='attempts/'+t.id+'-'+String(attempt.number).padStart(3,'0')+'-'+name+'.json'
  attempt[name]=await put(root,state,file,JSON.stringify(payload)+'\n');attempt.phase=name
  await atomicState(root,state,owner)
}
async function replay(root,t,attempt,name,fingerprint){
  if(attempt.fresh&&name!=='analysis')return null
  const prior=[...t.attempts].reverse().find(a=>a.number!==attempt.number&&a[name]&&(name==='analysis'||a.status==='interrupted'))
  if(!prior)return null
  const data=await evidenceJSON(root,prior[name]);if(data.fingerprint!==fingerprint)return null
  attempt[name]=prior[name];attempt.reused.push({stage:name,attempt:prior.number});return data
}
async function discover(root,state,t,attempt,run,fingerprint,options){
  const items=[]
  for(const capture of run.captures||[]){
    if(!capture.invoked)continue
    if(typeof capture.source!=='string'||capture.source.includes('\0')){items.push(requirement('inspect-binary-capture',{captureId:capture.capture},false));continue}
    if(state.tasks.some(child=>child.parentTaskId===t.id&&child.capture?.id===capture.capture&&child.sourceSha256===capture.sha256&&child.capture.fingerprint===fingerprint))continue
    if(state.tasks.length>=LIMIT.tasks){items.push(requirement('case-task-limit'));break}
    const sha=await sourceObject(root,state,capture.source),child=task(state,t.scenario,sha,t,{id:capture.capture,parentAttempt:attempt.number,fingerprint})
    const context={globals:options.globals??{},fixtures:options.fixtures??{},seed:options.seed??1},contextId=digest(context)
    state.contexts[contextId]=context;child.contextId=contextId
    let ancestor=t
    while(ancestor){if(ancestor.sourceSha256===sha){child.state='blocked';child.requirements=[requirement('capture-cycle',{ancestorTaskId:ancestor.id})];break}ancestor=state.tasks.find(x=>x.id===ancestor.parentTaskId)}
    if(child.depth>6){child.state='blocked';child.requirements=[requirement('absolute-depth-limit')]}
  }
  return items
}
async function runTask(root,state,t,owner,deadline,api){
  if(t.attempts.length>=LIMIT.attempts){t.state='blocked';t.requirements=[requirement('attempt-limit')];await atomicState(root,state,owner);return 'blocked'}
  const options=taskOptions(state,t,api),inputFingerprint=digest({engine:state.engineSha256,source:t.sourceSha256,options}),analysisFingerprint=digest({engine:state.engineSha256,source:t.sourceSha256,hints:options.hints??{}})
  const attempt={number:t.attempts.length+1,status:'running',phase:'start',startedAt:now(),fresh:t.freshExecution===true,reused:[]}
  delete t.freshExecution;t.state='running';t.requirements=[];t.attempts.push(attempt);await atomicState(root,state,owner)
  const source=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(await evidence(root,state.sources[t.sourceSha256]))
  let cached=await replay(root,t,attempt,'analysis',analysisFingerprint),analysis
  if(cached)analysis=cached.analysis
  else {try{analysis=api.analyze(source,options.hints??{})}catch(error){analysis={sha256:t.sourceSha256,dispatchers:[],diagnostics:[{message:String(error.message||error)}],caseAnalysisError:String(error.message||error)}}await stage(root,state,t,attempt,'analysis',{fingerprint:analysisFingerprint,analysis},owner)}
  const selected=analysis.dispatchers[options.dispatcher??0]
  const instrument=options.instrument!==false&&(options.probeOffset!==undefined||selected?.pc!=null&&!analysis.diagnostics.length)
  const executionOptions={...options,instrument},timeout=api.runOptions(options).timeoutMs
  async function execution(name,opts){
    const fingerprint=digest({inputFingerprint,stage:name})
    const reused=await replay(root,t,attempt,name,fingerprint)
    if(reused)return reused.run
    if(deadline-Date.now()<timeout+250){attempt.status='interrupted';attempt.phase='awaiting-'+name;t.state='pending';t.requirements=[requirement('increase-wall-budget',{minimumMs:timeout+500},false)];await atomicState(root,state,owner);return null}
    let run
    try{if(analysis.caseAnalysisError)throw Error(analysis.caseAnalysisError);run=await api.execute(source,opts,analysis)}catch(error){run={ok:false,partial:true,phase:'planning',error:String(error.message||error),events:[],captures:[]}}
    await stage(root,state,t,attempt,name,{fingerprint,run},owner);return run
  }
  const dynamic=await execution('dynamic',executionOptions);if(!dynamic)return 'paused'
  let baseline=null,validation={performed:false,reason:instrument?'disabled':'no-probe'}
  if(instrument&&options.verifyInstrumentation!==false&&dynamic.ok&&!dynamic.partial){baseline=await execution('baseline',{...executionOptions,instrument:false});if(!baseline)return 'paused';validation=validationOf(dynamic,baseline)}
  const trace=summarizeTrace(dynamic.events,analysis);trace.incomplete=dynamic.partial||trace.incomplete
  let lift=null;if(trace.steps&&selected)lift=liftTrace(analysis,dynamic.events,options)
  const needs=requirements(dynamic,analysis,trace,validation)
  if(options.followCaptured!==false&&(!validation.performed||validation.equivalentObservedBehavior===true))needs.push(...await discover(root,state,t,attempt,dynamic,inputFingerprint,options))
  const blocked=dynamic.partial||!dynamic.ok||needs.some(r=>r.blocking)
  t.state=blocked?'blocked':'complete';t.requirements=needs
  t.summary={executionOk:dynamic.ok,vmSteps:trace.steps,captured:dynamic.captures.length,validation,sourceSha256:t.sourceSha256,inputFingerprint}
  attempt.status=t.state;attempt.finishedAt=now()
  await stage(root,state,t,attempt,'result',{schemaVersion:1,taskId:t.id,sourceSha256:t.sourceSha256,engineSha256:state.engineSha256,inputFingerprint,
    analysis:attempt.analysis,dynamic:attempt.dynamic,baseline:attempt.baseline??null,validation,trace,lift,requirements:needs,completeDevirtualization:false},owner)
  return t.state
}
async function run(args,api){
  const root=await rootDirectory(args.caseDir),owner=await acquire(root)
  try{
    const state=await stateAt(root)
    if(state.engineSha256!==await api.engineFingerprint())throw Error('case engine fingerprint changed; create a new case to avoid mixing execution engines')
    const maxTasks=bounded(args.maxTasks,2,1,8,'maxTasks'),wall=bounded(args.wallTimeMs,30000,2000,120000,'wallTimeMs'),deadline=Date.now()+wall
    const retry=args.retryTaskIds??[],patches=args.taskOverrides??[]
    if(!Array.isArray(retry)||retry.length>LIMIT.tasks||new Set(retry).size!==retry.length||retry.some(id=>!state.tasks.some(t=>t.id===id)))throw Error('invalid retryTaskIds')
    if(!Array.isArray(patches)||patches.length>LIMIT.tasks||new Set(patches.map(p=>p.taskId)).size!==patches.length)throw Error('invalid taskOverrides')
    for(const p of patches){const t=state.tasks.find(t=>t.id===p.taskId);if(!t)throw Error('unknown override task');if(t.state==='complete'&&!retry.includes(t.id))throw Error('completed task overrides require explicit retryTaskIds');checkedOptions(p.options,api);checkedOptions(merge(taskOptions(state,t,api),p.options),api)}
    if(args.maxDepth!==undefined)state.maxDepth=bounded(args.maxDepth,3,1,6,'maxDepth')
    for(const t of state.tasks)if(t.state==='running'){t.state='pending';const a=t.attempts.at(-1);if(a?.status==='running'){a.status='interrupted';a.interruption='previous runner stopped before final checkpoint'}}
    for(const p of patches){const t=state.tasks.find(t=>t.id===p.taskId);const before=digest(t.overrides);t.overrides=merge(t.overrides,p.options);if(digest(t.overrides)!==before){t.state='pending';t.requirements=[]}}
    for(const id of retry){const t=state.tasks.find(t=>t.id===id);t.state='pending';t.freshExecution=true;t.requirements=[]}
    await atomicState(root,state,owner)
    const processed=[]
    while(processed.length<maxTasks&&Date.now()<deadline){
      const t=state.tasks.find(t=>t.state==='pending'&&t.depth<state.maxDepth);if(!t)break
      const outcome=await runTask(root,state,t,owner,deadline,api);processed.push({taskId:t.id,outcome});if(outcome==='paused')break
    }
    const result=summary(root,state,{processed});return {status:result.overall==='complete'?'observed':'partial',...result}
  }finally{await release(root,owner)}
}
async function status(args){
  const root=await rootDirectory(args.caseDir),state=await stateAt(root)
  let verified=0
  if(args.verifyEvidence===true){
    const files=new Map(Object.values(state.sources).map(r=>[r.file,r]))
    for(const t of state.tasks)for(const a of t.attempts)for(const k of ['analysis','dynamic','baseline','result'])if(a[k]){const old=files.get(a[k].file);if(old&&old.sha256!==a[k].sha256)throw Error('conflicting evidence descriptors');files.set(a[k].file,a[k])}
    for(const r of state.reports??[])for(const record of [r.json,r.markdown])files.set(record.file,record)
    for(const record of files.values()){await evidence(root,record);verified++}
  }
  return summary(root,state,{integrity:args.verifyEvidence===true?'verified':'not-checked',verifiedFiles:verified})
}
async function outcome(root,t){
  const attempt=[...t.attempts].reverse().find(a=>a.result)
  if(!attempt)return null
  const result=await evidenceJSON(root,attempt.result)
  if(result.taskId!==t.id||result.sourceSha256!==t.sourceSha256)throw Error('result/task provenance mismatch')
  if(!result.dynamic?.file.startsWith('attempts/'+t.id+'-'))throw Error('cross-task dynamic evidence')
  const stage=await evidenceJSON(root,result.dynamic)
  if(stage.fingerprint!==digest({inputFingerprint:result.inputFingerprint,stage:'dynamic'}))throw Error('dynamic evidence input fingerprint mismatch')
  return {result,run:stage.run}
}
async function compare(args){
  const root=await rootDirectory(args.caseDir),state=await stateAt(root),maxPairs=bounded(args.maxPairs,8,1,16,'maxPairs')
  if(args.baselineScenario===args.candidateScenario||![args.baselineScenario,args.candidateScenario].every(name=>state.scenarios.some(s=>s.name===name)))throw Error('select two distinct existing scenarios')
  const a=state.tasks.filter(t=>t.scenario===args.baselineScenario),b=state.tasks.filter(t=>t.scenario===args.candidateScenario),pairs=[],unmatched=[],ambiguous=[]
  const group=t=>t.depth+':'+t.sourceSha256
  for(const key of new Set([...a,...b].map(group))){
    const left=a.filter(t=>group(t)===key),right=b.filter(t=>group(t)===key)
    if(!left.length||!right.length){unmatched.push({key,baseline:left.map(t=>t.id),candidate:right.map(t=>t.id)});continue}
    if(left.length!==1||right.length!==1){ambiguous.push({key,baseline:left.map(t=>t.id),candidate:right.map(t=>t.id)});continue}
    if(pairs.length>=maxPairs){unmatched.push({key,reason:'pair-budget'});continue}
    const before=await outcome(root,left[0]),after=await outcome(root,right[0]);if(!before||!after){unmatched.push({key,reason:'missing-result'});continue}
    const trace=compareTraces(before.run.events,after.run.events),vmEvidence=trace.beforeSteps>0&&trace.afterSteps>0
    const beforeTrace=summarizeTrace(before.run.events),afterTrace=summarizeTrace(after.run.events)
    pairs.push({sourceSha256:left[0].sourceSha256,depth:left[0].depth,baselineTaskId:left[0].id,candidateTaskId:right[0].id,
      partial:left[0].state!=='complete'||right[0].state!=='complete',hasVmEvidence:vmEvidence,
      traceComparison:vmEvidence?trace:{...trace,equal:null,note:'No VM evidence on one or both sides.'},behaviorComparison:{equivalentObservedBehavior:digest(behavior(before.run))===digest(behavior(after.run))},
      coverageUnion:{observedOpcodes:[...new Set([...beforeTrace.opcodeFrequency,...afterTrace.opcodeFrequency].map(e=>e.opcode))],observedEdges:[...new Map([...beforeTrace.cfg,...afterTrace.cfg].map(e=>[JSON.stringify([e.from,e.to]),{from:e.from,to:e.to}])).values()],fullProgramCoverage:'unknown'}})
  }
  const result={schemaVersion:1,caseId:state.caseId,revision:state.revision,status:unmatched.length||ambiguous.length||!pairs.length||pairs.some(p=>p.partial)?'partial':'observed',baselineScenario:args.baselineScenario,candidateScenario:args.candidateScenario,pairs,unmatched,ambiguous,completeDevirtualization:false,
    limitations:['Pairs require the same source SHA-256 and layer depth.','Captured stages restart with explicit fixtures; closure/return-value context is not restored.','Equal observations do not prove semantic equivalence.']}
  if(args.saveReport!==false){
    const owner=await acquire(root)
    try{const current=await stateAt(root);if(current.reports.length>=64)throw Error('case report limit reached');const name=token()
      const text=['# Lua/Luau 案件对照报告','',args.baselineScenario+' → '+args.candidateScenario,'','状态：'+result.status,'',...pairs.map(p=>'- '+p.baselineTaskId+' / '+p.candidateTaskId+': VM 轨迹 '+(p.hasVmEvidence?p.traceComparison.equal?'一致':'存在分歧':'无证据')+'；观察行为 '+(p.behaviorComparison.equivalentObservedBehavior?'一致':'不同')),'','未匹配组：'+unmatched.length+'；歧义组：'+ambiguous.length,'','所有结果均为指定离线夹具下的观测，不代表完整反虚拟化。',''].join('\n')
      const json=await put(root,current,'reports/'+name+'.json',JSON.stringify(result,null,2)+'\n'),markdown=await put(root,current,'reports/'+name+'.md',text)
      current.reports.push({json,markdown,sourceRevision:state.revision});await atomicState(root,current,owner);result.artifacts={json:resolve(root,json.file),report:resolve(root,markdown.file)}
    }finally{await release(root,owner)}
  }
  return result
}
export async function luaCaseCall(name,args,api){
  plain(args,'case arguments')
  if(name==='lua_case_create')return create(args,api)
  if(name==='lua_case_run')return run(args,api)
  if(name==='lua_case_status')return status(args)
  if(name==='lua_case_compare')return compare(args)
  throw Error('unknown Lua case tool: '+name)
}
