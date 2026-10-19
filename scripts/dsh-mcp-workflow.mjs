/**
 * DSH MCP P1 DAG executor.
 * Durable, bounded, no eval/shell, no retries of side effects.
 * No background guarantee when the MCP process is stopped: resume is explicit.
 */
import {randomBytes,createHash} from 'node:crypto'
import {mkdir,readFile,writeFile,rename,rm,lstat,realpath,open} from 'node:fs/promises'
import {join,resolve} from 'node:path'
import {checkedJson,validateToolInput} from './dsh-mcp-governance.mjs'

const MAX_NODES=24, MAX_DOC=512*1024, MAX_RESULT=96*1024, MAX_EVENTS=100
const SAFE_TOOLS=new Set([
 'tool_registry_list','tool_validate','tool_latency_report','mcp_server_health','mcp_tool_search',
 'mcp_registry_audit','protocol_decode','protocol_encode','protocol_hash','protocol_parse_url',
 'protocol_parse_http','reverse_capabilities','no_root_capabilities','code_verify_recipes',
 'code_index_query','code_semantic_index','code_symbol_references','code_dependency_graph',
 'code_call_graph','code_change_impact','code_test_impact','code_patch_plan',
 'code_contract_check','code_regression_bisect','code_checkpoint','code_diagnostics',
 'git_status','git_diff','git_log','process_list','android_shell_health'
])
// Write operations are explicitly bounded and always executed at most once.
const WRITE_TOOLS=new Set(['code_transaction_apply','code_ast_edit','code_refactor'])
const isObj=v=>v!==null&&typeof v==='object'&&!Array.isArray(v)
const hash=v=>createHash('sha256').update(v).digest('hex')
const idValid=id=>typeof id==='string'&&/^wf-[0-9a-f]{24}$/.test(id)
const errorString=e=>String(e?.message||e||'Operation failed').slice(0,240)
const maxInt=(n,def,cap)=>Number.isInteger(n)?Math.max(1,Math.min(cap,n)):def
function validateNodes(nodes,list,{allowSideEffects=false}={}){
 if(!Array.isArray(nodes)||nodes.length===0||nodes.length>MAX_NODES)throw Error('MCP_WORKFLOW_NODES_1_TO_24')
 const tools=new Map(list().map(x=>[x.name,x]))
 const seen=new Map()
 for(const n of nodes){
  if(!isObj(n)||typeof n.id!=='string'||!/^[a-z][a-z0-9_-]{0,39}$/.test(n.id)||seen.has(n.id))
   throw Error('MCP_WORKFLOW_INVALID_NODE_ID')
  if(typeof n.tool!=='string'||!tools.has(n.tool))throw Error('MCP_WORKFLOW_TOOL_UNAVAILABLE: '+n.tool)
  if(!SAFE_TOOLS.has(n.tool)&&!WRITE_TOOLS.has(n.tool))throw Error('MCP_WORKFLOW_TOOL_NOT_AUDITED: '+n.tool)
  if(WRITE_TOOLS.has(n.tool)&&(!allowSideEffects||n.effect!=='write'))
   throw Error('MCP_WORKFLOW_WRITE_REQUIRES_APPROVAL: '+n.id)
  if(WRITE_TOOLS.has(n.tool)&&n.args?.dryRun!==false)
   throw Error('MCP_WORKFLOW_WRITE_REQUIRES_EXPLICIT_COMMIT: '+n.id)
  const deps=n.dependsOn??[]
  if(!Array.isArray(deps)||deps.length>MAX_NODES||new Set(deps).size!==deps.length||
    deps.some(d=>typeof d!=='string'))throw Error('MCP_WORKFLOW_INVALID_DEPENDENCIES')
  const args=n.args??{}
  if(!isObj(args))throw Error('MCP_WORKFLOW_INVALID_ARGS')
  checkedJson(args,128*1024)
  seen.set(n.id,{id:n.id,tool:n.tool,args,dependsOn:deps,effect:WRITE_TOOLS.has(n.tool)?'write':'read'})
 }
 for(const n of seen.values())for(const d of n.dependsOn)
  if(!seen.has(d)||d===n.id)throw Error('MCP_WORKFLOW_MISSING_DEPENDENCY: '+n.id)
 const degrees=new Map([...seen].map(([k,n])=>[k,n.dependsOn.length]))
 const layers=[],done=new Set()
 for(let count=0;count<MAX_NODES;count++){
  const ready=[...seen.values()].filter(n=>!done.has(n.id)&&n.dependsOn.every(d=>done.has(d)))
  if(!ready.length)break
  layers.push(ready.map(n=>n.id))
  ready.forEach(n=>done.add(n.id))
 }
 if(done.size!==seen.size)throw Error('MCP_WORKFLOW_CYCLIC_DAG')
 return {nodes:[...seen.values()],layers,writeCount:[...seen.values()].filter(x=>x.effect==='write').length}
}
function select(value,path){
 if(!Array.isArray(path)||path.length>12)throw Error('MCP_WORKFLOW_INVALID_RESULT_PATH')
 let v=value
 for(const k of path){
  if(!(typeof k==='string'||Number.isSafeInteger(k))||k==='__proto__'||k==='constructor'||k==='prototype')
   throw Error('MCP_WORKFLOW_UNSAFE_RESULT_PATH')
  if(v===null||typeof v!=='object'||!Object.hasOwn(v,k))throw Error('MCP_WORKFLOW_RESULT_PATH_NOT_FOUND')
  v=v[k]
 }
 return v
}
function resolveRefs(input,results,depth=0){
 if(depth>16)throw Error('MCP_WORKFLOW_ARG_DEPTH')
 if(Array.isArray(input))return input.map(v=>resolveRefs(v,results,depth+1))
 if(!isObj(input))return input
 const keys=Object.keys(input)
 if(keys.length===2&&keys.includes('$from')&&keys.includes('path')){
  if(!results.has(input.$from))throw Error('MCP_WORKFLOW_REFERENCE_NOT_READY: '+input.$from)
  return select(results.get(input.$from),input.path)
 }
 return Object.fromEntries(Object.entries(input).map(([k,v])=>[k,resolveRefs(v,results,depth+1)]))
}
export function compactMcpResult(input={},limitDefault=1600){
 const value=Object.hasOwn(input,'value')?input.value:undefined
 const serialized=checkedJson(value,MAX_DOC)
 const maxChars=maxInt(input.maxChars,limitDefault,10000)
 const bytes=Buffer.byteLength(serialized),summary=serialized.length>maxChars?
   serialized.slice(0,Math.ceil(maxChars/2))+' … [omitted] … '+serialized.slice(-Math.floor(maxChars/2)):serialized
 return {sha256:hash(serialized),bytes,truncated:serialized.length>maxChars,preview:summary,
  originalInResponse:serialized.length<=maxChars,format:'json',note:'Preview is not a lossless replacement; SHA-256 refers to original JSON.'}
}
export function createMcpWorkflowEngine({list,execute,storageDir=join(process.env.HOME||process.cwd(),'.dsh','mobile','mcp-workflows'),metrics}={}){
 if(typeof list!=='function'||typeof execute!=='function')throw Error('MCP_WORKFLOW_DEPENDENCIES_REQUIRED')
 const running=new Map(), locks=new Map(), allEvents=[]
 let storeReady=null
 async function directory(){
  if(!storeReady)storeReady=(async()=>{
   const p=resolve(storageDir)
   await mkdir(p,{recursive:true,mode:0o700})
   const actual=await realpath(p),stat=await lstat(p)
   if(!stat.isDirectory()||stat.isSymbolicLink()||actual!==p)throw Error('MCP_WORKFLOW_UNSAFE_STORE')
   return p
  })()
  return storeReady
 }
 async function read(id){
  if(!idValid(id))throw Error('MCP_WORKFLOW_INVALID_ID')
  const path=join(await directory(),id+'.json'),st=await lstat(path)
  if(!st.isFile()||st.isSymbolicLink()||st.size>MAX_DOC)throw Error('MCP_WORKFLOW_BAD_RECORD')
  const data=JSON.parse(await readFile(path,'utf8'))
  if(data.id!==id||data.schema!==1||!Array.isArray(data.nodes))throw Error('MCP_WORKFLOW_INVALID_RECORD')
  return data
 }
 async function persist(doc){
  // Async writes are serialized for each workflow, with atomic rename and fsync.
  const previous=locks.get(doc.id)||Promise.resolve()
  const work=previous.catch(()=>{}).then(async()=>{
   const root=await directory(),path=join(root,doc.id+'.json'),tmp=path+'.'+randomBytes(4).toString('hex')+'.tmp'
   const payload=checkedJson(doc,MAX_DOC)
   const file=await open(tmp,'wx',0o600)
   try{await file.writeFile(payload);await file.sync()}finally{await file.close()}
   try{await rename(tmp,path)}finally{await rm(tmp,{force:true}).catch(()=>{})}
  })
  locks.set(doc.id,work)
  try{await work}finally{if(locks.get(doc.id)===work)locks.delete(doc.id)}
 }
 function event(doc,type,nodeId,more={}){
  const entry={at:Date.now(),type,nodeId:nodeId||null,...more}
  doc.events.push(entry);if(doc.events.length>MAX_EVENTS)doc.events.shift()
  allEvents.push({workflow:doc.id,...entry});if(allEvents.length>MAX_EVENTS)allEvents.shift()
 }
 function publicDoc(doc,includeResults=false){
  const nodes=doc.nodes.map(n=>({id:n.id,tool:n.tool,status:n.status,dependsOn:n.dependsOn,
   effect:n.effect,startedAt:n.startedAt??null,endedAt:n.endedAt??null,
   error:n.error??null,resultSha256:n.resultSha256??null,
   ...(includeResults&&n.status==='completed'?{result:n.result}: {})}))
  return {id:doc.id,status:doc.status,createdAt:doc.createdAt,updatedAt:doc.updatedAt,
   cancelled:!!doc.cancelRequested,allowSideEffects:doc.allowSideEffects,nodes,revision:doc.revision,
   recovery:'Interrupted or running steps are NEVER re-executed automatically; use checkpoint restore.'}
 }
 function plan(input={}){
  const validated=validateNodes(input.nodes,list,{allowSideEffects:input.allowSideEffects===true})
  return {valid:true,nodes:validated.nodes.map(n=>({id:n.id,tool:n.tool,dependsOn:n.dependsOn,effect:n.effect})),
   layers:validated.layers,maxParallel:maxInt(input.concurrency,2,4),requiresExplicitWrites:validated.writeCount>0,
   sideEffectfulNodes:validated.writeCount,estimatedCalls:validated.nodes.length,noWritesPerformed:true}
 }
 async function create(input={}){
  const parsed=validateNodes(input.nodes,list,{allowSideEffects:input.allowSideEffects===true})
  const id='wf-'+randomBytes(12).toString('hex'),now=Date.now()
  const doc={schema:1,id,status:'queued',createdAt:now,updatedAt:now,revision:0,
   cancelRequested:false,allowSideEffects:input.allowSideEffects===true,
   concurrency:maxInt(input.concurrency,2,4),nodes:parsed.nodes.map(n=>({...n,status:'pending'})),
   events:[]}
  event(doc,'created')
  await persist(doc)
  running.set(id,{doc,cancelRequested:false})
  void run(id).catch(async e=>{
   const state=running.get(id)
   if(state){state.doc.status='interrupted';event(state.doc,'error',null,{code:errorString(e)})
    await persist(state.doc).catch(()=>{});running.delete(id)}
  })
  return {id,status:'queued',nodes:doc.nodes.length,accepted:true,writeCount:parsed.writeCount,
   note:'Asynchronous execution begins in MCP process; no guarantee once process exits.'}
 }
 async function run(id){
  const state=running.get(id);if(!state)return
  const doc=state.doc
  doc.status='running';doc.updatedAt=Date.now();doc.revision++;event(doc,'running')
  await persist(doc)
  const results=new Map(doc.nodes.filter(n=>n.status==='completed').map(n=>[n.id,n.result]))
  while(true){
   if(state.cancelRequested||doc.cancelRequested){
    doc.cancelRequested=true
    for(const n of doc.nodes)if(n.status==='pending'){n.status='cancelled';event(doc,'cancelled',n.id)}
    break
   }
   let changed=false
   for(const n of doc.nodes){
    if(n.status==='pending'&&n.dependsOn.some(d=>doc.nodes.find(x=>x.id===d)?.status!=='completed'&&
      ['failed','blocked','cancelled','interrupted'].includes(doc.nodes.find(x=>x.id===d)?.status))){
     n.status='blocked';event(doc,'blocked',n.id);changed=true
    }
   }
   const ready=doc.nodes.filter(n=>n.status==='pending'&&n.dependsOn.every(d=>doc.nodes.find(x=>x.id===d)?.status==='completed')).slice(0,doc.concurrency)
   if(!ready.length){if(changed)continue;break}
   for(const n of ready){n.status='running';n.startedAt=Date.now();event(doc,'start',n.id)}
   doc.updatedAt=Date.now();doc.revision++;await persist(doc)
   await Promise.all(ready.map(async n=>{
    try{
     const args=resolveRefs(n.args,results)
     const def=list().find(t=>t.name===n.tool)
     if(!def)throw Error('MCP_WORKFLOW_TOOL_DISABLED')
     validateToolInput(def,args)
     // Side-effecting nodes must remain approved when run actually starts.
     if(n.effect==='write'&&(!doc.allowSideEffects||n.args?.dryRun!==false))throw Error('MCP_WORKFLOW_WRITE_APPROVAL_EXPIRED')
     const result=await execute(n.tool,args)
     const serialized=checkedJson(result,MAX_RESULT)
     n.resultSha256=hash(serialized);n.result=result;n.status='completed';results.set(n.id,result)
    }catch(e){n.status='failed';n.error=errorString(e)}
    n.endedAt=Date.now();event(doc,n.status,n.id,{durationMs:n.endedAt-n.startedAt})
    metrics?.record?.(n.tool,n.endedAt-n.startedAt,n.status==='completed')
   }))
   doc.updatedAt=Date.now();doc.revision++;await persist(doc)
  }
  doc.status=doc.cancelRequested?'cancelled':doc.nodes.some(n=>n.status==='failed'||n.status==='blocked')?'failed':
   doc.nodes.every(n=>n.status==='completed')?'completed':'interrupted'
  doc.updatedAt=Date.now();doc.revision++;event(doc,doc.status)
  await persist(doc);running.delete(id)
 }
 async function status(input={}){
  const id=input.id,doc=running.get(id)?.doc||await read(id)
  return publicDoc(doc,input.includeResults===true)
 }
 async function cancel(input={}){
  const id=input.id
  if(!idValid(id))throw Error('MCP_WORKFLOW_INVALID_ID')
  const state=running.get(id)
  if(!state){
   const doc=await read(id)
   if(['completed','failed','cancelled'].includes(doc.status))return {id,status:doc.status,alreadyTerminal:true}
   doc.cancelRequested=true;doc.status='cancelled'
   for(const n of doc.nodes)if(n.status==='pending')n.status='cancelled'
   doc.updatedAt=Date.now();await persist(doc)
   return {id,status:'cancelled',inFlightNotAborted:true}
  }
  state.cancelRequested=true;state.doc.cancelRequested=true
  // No unsafe force-kill: in-flight writes must finish or be recovered by their own transaction journal.
  return {id,status:'cancelling',inFlightNotAborted:true}
 }
 async function restore(input={}){
  const id=input.id
  if(running.has(id))throw Error('MCP_WORKFLOW_ALREADY_ACTIVE')
  const doc=await read(id)
  const action=input.action||'inspect'
  if(!['inspect','resume'].includes(action))throw Error('MCP_WORKFLOW_INVALID_RESTORE_ACTION')
  const interrupted=doc.nodes.filter(n=>n.status==='running')
  if(action==='inspect')return {id,status:doc.status,interruptedNodes:interrupted.map(n=>n.id),
   resumableNodes:doc.nodes.filter(n=>n.status==='pending'&&n.effect==='read').map(n=>n.id),
   writeNodesNeverReplayed:true}
  if(['completed','cancelled'].includes(doc.status))throw Error('MCP_WORKFLOW_ALREADY_TERMINAL')
  if(doc.nodes.some(n=>n.effect==='write'&&n.status==='pending'))throw Error('MCP_WORKFLOW_WRITE_RESUME_REQUIRES_NEW_APPROVAL')
  for(const n of interrupted){n.status='interrupted';n.error='PROCESS_INTERRUPTED_NOT_REPLAYED';event(doc,'interrupted',n.id)}
  if(doc.cancelRequested)throw Error('MCP_WORKFLOW_CANCELLED')
  // A dependent of an interrupted node can never be resumed safely.
  const pending=doc.nodes.filter(n=>n.status==='pending')
  if(!pending.length){doc.status='interrupted';await persist(doc);return {id,status:doc.status,resumed:false}}
  doc.status='queued';doc.updatedAt=Date.now();event(doc,'restore')
  await persist(doc);running.set(id,{doc,cancelRequested:false})
  void run(id).catch(async e=>{const cur=running.get(id);if(cur){cur.doc.status='interrupted';event(cur.doc,'error',null,{code:errorString(e)});await persist(cur.doc).catch(()=>{});running.delete(id)}})
  return {id,resumed:true,status:'queued',interruptedNodes:interrupted.map(n=>n.id),writeNodesNeverReplayed:true}
 }
 function capabilities(){
  const t=list(),names=new Set(t.map(x=>x.name))
  return {server:'mobile_tools',visibleTools:t.length,workflowSafeTools:t.filter(x=>SAFE_TOOLS.has(x.name)).length,
   explicitlyApprovedWriteTools:t.filter(x=>WRITE_TOOLS.has(x.name)).length,
   capabilities:{dag:true,asyncExecution:true,durableSnapshots:true,explicitResume:true,cooperativeCancel:true,
    writeReplay:false,abortInFlight:false,toolSetIncludesCoding:names.has('code_index_query'),
    toolsSearch:names.has('mcp_tool_search'),nativeAndroidVerified:false},
   node:{version:process.version,platform:process.platform,arch:process.arch},
   notes:'Reports registration and engine support, not device-level proof of each handler.'}
 }
 async function trace(input={}){
  const id=input.id
  const events=id?(running.get(id)?.doc||await read(id)).events:allEvents
  const perTool={}
  for(const e of events){
   if(!e.nodeId)continue
   perTool[e.type]=(perTool[e.type]||0)+1
  }
  const completed=events.filter(e=>e.type==='completed'),latency=completed.map(x=>x.durationMs||0).sort((a,b)=>a-b)
  return {id:id||null,events:events.slice(-maxInt(input.limit,40,100)),counts:perTool,
   completed:completed.length,p50Ms:latency.length?latency[Math.floor((latency.length-1)*.5)]:null,
   p95Ms:latency.length?latency[Math.ceil(latency.length*.95)-1]:null,
   private:true,argumentsRecorded:false,resultsRecorded:false}
 }
 return {plan,execute:create,status,cancel,restore,compact:compactMcpResult,capabilities,trace}
}
