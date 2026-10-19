import {mkdtemp,rm,writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createMcpWorkflowEngine,compactMcpResult} from './dsh-mcp-workflow.mjs'
const check=(yes,msg)=>{if(!yes)throw Error(msg)}
const dir=await mkdtemp(join(tmpdir(),'mcp-dag-'))
const called=[],defs=['protocol_decode','protocol_hash','code_ast_edit'].map(name=>({name,inputSchema:{type:'object',properties:{value:{},dryRun:{type:'boolean'}},additionalProperties:false}}))
const engine=createMcpWorkflowEngine({storageDir:dir,list:()=>defs,execute:async (name,args)=>{called.push({name,args});return {value:args.value??name}}})
try{
 let failed=false;try{engine.plan({nodes:[{id:'a',tool:'protocol_decode',dependsOn:['b']},{id:'b',tool:'protocol_hash',dependsOn:['a']}]})}catch{failed=true}check(failed,'cycle accepted')
 failed=false;try{engine.plan({nodes:[{id:'a',tool:'code_ast_edit',args:{dryRun:false}}]})}catch{failed=true}check(failed,'write without approval accepted')
 const nodes=[{id:'one',tool:'protocol_decode',args:{value:'ABC'}},{id:'two',tool:'protocol_hash',dependsOn:['one'],args:{value:{$from:'one',path:['value']}}}]
 const plan=engine.plan({nodes});check(plan.layers.length===2,'DAG layers')
 const job=await engine.execute({nodes});check(job.accepted,'not accepted')
 let result;for(let k=0;k<80;k++){result=await engine.status({id:job.id,includeResults:true});if(['completed','failed'].includes(result.status))break;await new Promise(r=>setTimeout(r,20))}
 check(result.status==='completed','workflow failed '+JSON.stringify(result))
 check(result.nodes[1].result.value==='ABC','dependency result link missing')
 check(called.length===2,'unexpected calls')
 const persisted=createMcpWorkflowEngine({storageDir:dir,list:()=>defs,execute:async()=>{throw Error('unexpected replay')}})
 const restored=await persisted.status({id:job.id});check(restored.status==='completed','persistence missing')
 const preview=compactMcpResult({value:{a:'ABCDEFGHIJK'},maxChars:4});check(preview.truncated&&preview.sha256.length===64,'compaction')
 const probe=await engine.restore({id:job.id,action:'inspect'});check(!probe.writeNodesNeverReplayed===false||probe.writeNodesNeverReplayed,'restore introspection')
 const denied=await engine.plan({nodes:[{id:'edit',tool:'code_ast_edit',args:{dryRun:false},effect:'write'}],allowSideEffects:true})
 check(denied.sideEffectfulNodes===1,'approved write plan')
 const failing=createMcpWorkflowEngine({storageDir:dir,list:()=>defs,execute:async()=>{throw Error('intentional failure')}})
 const failureJob=await failing.execute({nodes:[{id:'first',tool:'protocol_decode'},{id:'dependent',tool:'protocol_hash',dependsOn:['first']}]})
 let state;for(let k=0;k<80;k++){state=await failing.status({id:failureJob.id});if(state.status==='failed')break;await new Promise(r=>setTimeout(r,20))}
 check(state.status==='failed'&&state.nodes.find(n=>n.id==='dependent').status==='blocked','failure propagation')
 let release;let entered=false
 const wait=new Promise(resolve=>{release=resolve})
 const abortable=createMcpWorkflowEngine({storageDir:dir,list:()=>defs,
  execute:async(name)=>{entered=true;await wait;return {name}}})
 const cancelJob=await abortable.execute({nodes:[{id:'slow',tool:'protocol_decode'},{id:'later',tool:'protocol_hash',dependsOn:['slow']}]})
 for(let k=0;k<50&&!entered;k++)await new Promise(r=>setTimeout(r,10))
 check(entered,'async job did not start')
 const cancelState=await abortable.cancel({id:cancelJob.id})
 check(cancelState.inFlightNotAborted,'unsafe cancellation semantics')
 release()
 let terminal;for(let k=0;k<80;k++){terminal=await abortable.status({id:cancelJob.id});if(terminal.status==='cancelled')break;await new Promise(r=>setTimeout(r,15))}
 check(terminal.status==='cancelled'&&terminal.nodes.find(n=>n.id==='later').status==='cancelled','cancel did not prevent dependent task')
 const trace=await engine.trace({id:job.id})
 check(trace.completed===2&&trace.events.length>0,'trace aggregates')
 const recoveredId='wf-111111111111111111111111'
 const crashDoc={schema:1,id:recoveredId,status:'running',createdAt:Date.now(),updatedAt:Date.now(),
  revision:0,cancelRequested:false,allowSideEffects:true,concurrency:2,
  nodes:[{id:'interrupted_write',tool:'code_ast_edit',args:{dryRun:false},dependsOn:[],effect:'write',status:'running'},
   {id:'dependent_read',tool:'protocol_decode',args:{},dependsOn:['interrupted_write'],effect:'read',status:'pending'}],events:[]}
 await writeFile(join(dir,recoveredId+'.json'),JSON.stringify(crashDoc))
 let replayed=0
 const recovery=createMcpWorkflowEngine({storageDir:dir,list:()=>defs,execute:async()=>{replayed++;throw Error('unexpected replay')}})
 const inspecting=await recovery.restore({id:recoveredId,action:'inspect'})
 check(inspecting.writeNodesNeverReplayed&&inspecting.interruptedNodes.includes('interrupted_write'),'crash inspection')
 const resume=await recovery.restore({id:recoveredId,action:'resume'})
 check(resume.resumed,'recovery not queued')
 let recovered
 for(let k=0;k<80;k++){recovered=await recovery.status({id:recoveredId});if(['failed','interrupted'].includes(recovered.status))break;await new Promise(r=>setTimeout(r,15))}
 check(replayed===0&&recovered.nodes[0].status==='interrupted'&&recovered.nodes[1].status==='blocked',
  'interrupted write was replayed')
 const governed=createMcpWorkflowEngine({storageDir:dir,list:()=>defs,
  execute:async n=>({value:n}),resourceBudget:async()=>({lowMemory:true,thermalStatus:5})})
 const limitedJob=await governed.execute({nodes:[{id:'limited',tool:'protocol_decode'}],concurrency:4})
 let limited
 for(let k=0;k<80;k++){
  limited=await governed.status({id:limitedJob.id})
  if(['completed','failed','cancelled'].includes(limited.status))break
  await new Promise(resolve=>setTimeout(resolve,15))
 }
 check(limited.status==='completed'&&limited.effectiveConcurrency===1&&limited.resourceLimited,'Android budget did not throttle')
 const cancelled=await engine.cancel({id:job.id});check(cancelled.alreadyTerminal,'cancel terminal')
 console.log('[DSH] P1 MCP DAG persistent workflow self-test: OK')
}finally{await rm(dir,{recursive:true,force:true})}
