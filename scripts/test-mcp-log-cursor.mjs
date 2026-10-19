import {createMcpLogCursor} from './dsh-mcp-log-cursor.mjs'
const assert=(ok,msg)=>{if(!ok)throw Error(msg)}
let round=0
const reader=async()=>({lines:round++===0?['1760000000.10 old','1760000000.20 common']:['1760000000.20 common','1760000000.30 new'],truncated:false})
const c=createMcpLogCursor({read:reader})
const first=await c.delta({cursor:'a'}),second=await c.delta({cursor:'a'})
assert(first.lines.length===2,'initial log')
assert(second.lines.length===1&&second.lines[0].includes('new'),'dedup log')
let failed=false;try{await c.delta({cursor:'../../bad'})}catch{failed=true}assert(failed,'unsafe cursor')
console.log('[DSH] Android logcat delta cursor self-test: OK')
