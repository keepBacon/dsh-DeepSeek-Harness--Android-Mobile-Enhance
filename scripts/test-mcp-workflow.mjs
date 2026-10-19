import {mkdtemp,rm} from 'node:fs/promises'
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
 const cancelled=await engine.cancel({id:job.id});check(cancelled.alreadyTerminal,'cancel terminal')
 console.log('[DSH] P1 MCP DAG persistent workflow self-test: OK')
}finally{await rm(dir,{recursive:true,force:true})}
