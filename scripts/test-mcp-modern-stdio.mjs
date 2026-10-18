import {handleModernRequest} from './dsh-mcp-modern-stdio.mjs'
const assert=(a,m)=>{if(!a)throw Error(m)}
const meta={'io.modelcontextprotocol/protocolVersion':'2026-07-28','io.modelcontextprotocol/clientCapabilities':{},'io.modelcontextprotocol/clientInfo':{name:'test',version:'1'}}
const api={list:()=>[{name:'read',description:'Read a status',inputSchema:{type:'object',properties:{},additionalProperties:false}}],execute:async n=>({value:n})}
const send=async(method,params={})=>handleModernRequest({jsonrpc:'2.0',id:19,method,params:{_meta:meta,...params}},api)
const discovery=await send('server/discover')
assert(discovery.result?.supportedVersions.includes('2026-07-28'),'protocol discover')
assert(discovery.result?._meta?.['io.modelcontextprotocol/serverInfo']?.name==='dsh-mobile-toolbox','server info')
const list=await send('tools/list');assert(list.result?.tools?.length===1,'tools list')
const call=await send('tools/call',{name:'read',arguments:{}})
assert(call.result?.structuredContent?.value==='read','call result')
assert(call.result?.resultType==='complete'&&call.result?.cacheScope==='private','result envelope')
const bad=await handleModernRequest({jsonrpc:'2.0',id:3,method:'tools/list',params:{_meta:{'io.modelcontextprotocol/protocolVersion':'2025-11-25'}}},api)
assert(bad.error?.code===-32001,'protocol mismatch')
const failed=await handleModernRequest({jsonrpc:'2.0',id:22,method:'tools/call',params:{_meta:meta,name:'oops'}},{...api,execute:()=>{throw Error('handler crashed')}})
assert(failed.result?.isError===true,'tool fault isolation')
console.log('[DSH] 2026-07-28 stateless stdio dispatch self-test: OK')
