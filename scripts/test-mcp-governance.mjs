import {createMcpGovernance,checkedJson,validateToolInput,catalogueAudit} from './dsh-mcp-governance.mjs'
const ok=(v,msg)=>{if(!v)throw Error(msg)}
const defs=[
 {name:'ping',description:'Read-only ping status',inputSchema:{type:'object',properties:{},additionalProperties:false}},
 {name:'work',description:'Build project work queue',inputSchema:{type:'object',properties:{items:{type:'array',items:{type:'string'},maxItems:3}},required:['items'],additionalProperties:false}}
]
const g=createMcpGovernance({list:()=>defs,invoke:async(n)=>({name:n,status:'ok'}),source:()=>"{name:'ping',description:'a'}\ncase 'ping':\n{name:'work',description:'b'}\ncase 'work':\n"})
ok(g.search({query:'work'}).tools[0].name==='work','search')
ok(g.audit().consistent,'audit')
ok((await g.probe({name:'work'})).status==='UNSAFE_TO_PROBE','unsafe probe')
ok((await g.execute('work',{items:['x']})).status==='ok','dispatch')
let rejected=false;try{await g.execute('work',{items:[22]})}catch{rejected=true}ok(rejected,'nested schema')
rejected=false;try{await g.execute('work',{items:['x'],extra:1})}catch{rejected=true}ok(rejected,'unknown field')
for(const invalid of [undefined,NaN,Infinity,1n,()=>{},new Date(),{x:undefined},[,'x']]){
 let failed=false;try{checkedJson(invalid)}catch{failed=true}ok(failed,'invalid JSON '+String(invalid))
}
ok(checkedJson({nested:[null,'汉字',9]})==='{"nested":[null,"汉字",9]}','lossless')
const audit=catalogueAudit(defs,"case 'ping':\n");ok(audit.missingHandlers.includes('work'),'dead handler detection')
ok(g.status().calls===1,'error counters')
console.log('[DSH] MCP P0 governance and validation self-test: OK')
