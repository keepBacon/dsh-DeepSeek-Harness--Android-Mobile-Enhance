#!/usr/bin/env node
import assert from 'node:assert/strict'
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {vmAssistTools,vmAssistCall} from './dsh-vm-assist.mjs'
import {mobileDispatchToolCall} from './dsh-mobile-toolbox-mcp.mjs'
assert.equal(vmAssistTools.length,8)
const loader='loadstring(game:HttpGet("https://api.luarmor.net/files/v4/loaders/770f1268f3bd440047ae5e267c42e310.lua"))()'
const boot=await vmAssistCall('reverse_loader_analyze',{source:loader})
assert.equal(boot.stage,'remote-bootstrap')
assert.ok(boot.urls?.[0]?.luarmorV4)
assert.equal((await vmAssistCall('reverse_vm_detect',{source:loader})).probableVM,false)
const vm=['local bytecode={1,2,3}','local constants={"Hello",42}','local pc=1','while true do',' local opcode=bytecode[pc]',' pc=pc+1',' if opcode==1 then registers[1]=constants[2]',' elseif opcode==2 then registers[1]=registers[2]+registers[3]',' end','end'].join('\n')
const detected=await vmAssistCall('reverse_vm_detect',{source:vm})
assert.ok(detected.probableVM)
const handlers=await vmAssistCall('reverse_vm_handlers',{source:vm})
assert.ok(handlers.handlers.length>=2)
const pools=await vmAssistCall('reverse_vm_pools',{source:vm})
assert.equal(pools.tables.length,2)
const lifted=await vmAssistCall('reverse_vm_lift',{source:vm})
assert.ok(lift.handlers.length>0)
const trace=await vmAssistCall('reverse_vm_trace_plan',{source:vm})
assert.ok(Array.isArray(trace.anchors))
const decoded=await vmAssistCall('reverse_vm_bytecode_transform',{encoding:'hex',data:'010203',steps:[{operation:'xor',value:255}]})
assert.equal(decoded.hex,'fefdfc')
const report=await vmAssistCall('reverse_vm_report',{source:loader})
assert.equal(report.executed,false)
assert.equal(report.fetched,false)
const routed=await mobileDispatchToolCall({name:'reverse_loader_analyze',arguments:{source:loader}})
assert.equal(routed.structuredContent.stage,'remote-bootstrap')
const root=await mkdtemp(join(tmpdir(),'dsh-vm-'))
try{
 const file=join(root,'sample.lua')
 await writeFile(file,vm)
 assert.ok((await vmAssistCall('reverse_vm_handlers',{path:file})).handlers.length>0)
 assert.equal(await readFile(file,'utf8'),vm)
}finally{await rm(root,{recursive:true,force:true})}
console.log('[DSH] Luau VM reverse assistant and MCP dispatch regression: OK')
