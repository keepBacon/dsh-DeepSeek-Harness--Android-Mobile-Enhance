/**
 * Experimental 2026-07-28 stateless MCP stdio transport.
 * Explicit opt-in only; the installed legacy SDK is still the default.
 * One bounded JSON-RPC object per line; no session or auto-replay.
 */
import {createInterface} from 'node:readline'
import {checkedJson} from './dsh-mcp-governance.mjs'

const VERSION='2026-07-28'
const base={resultType:'complete',cacheScope:'private',ttlMs:0}
const own=(o,k)=>Object.prototype.hasOwnProperty.call(o,k)
const error=(id,code,message)=>({jsonrpc:'2.0',id,error:{code,message:String(message).slice(0,300)}})
const result=(id,value)=>({jsonrpc:'2.0',id,result:{...base,...value}})
export function handleModernRequest(request,{list,execute,context}){
 if(!request||request.jsonrpc!=='2.0'||!own(request,'id')||typeof request.method!=='string')
  return Promise.resolve(error(request?.id??null,-32600,'Invalid Request'))
 const {id,method}=request
 const meta=request.params?._meta||{}
 if(!Object.prototype.hasOwnProperty.call(meta,'io.modelcontextprotocol/protocolVersion'))
  return Promise.resolve(error(id,-32602,'Protocol version metadata required'))
 if(!Object.prototype.hasOwnProperty.call(meta,'io.modelcontextprotocol/clientCapabilities')||
    !meta['io.modelcontextprotocol/clientCapabilities']||
    typeof meta['io.modelcontextprotocol/clientCapabilities']!=='object'||
    Array.isArray(meta['io.modelcontextprotocol/clientCapabilities']))
  return Promise.resolve(error(id,-32602,'Client capabilities metadata required'))
 if(meta['io.modelcontextprotocol/protocolVersion']!==VERSION)
  return Promise.resolve({jsonrpc:'2.0',id,error:{code:-32022,
   message:'UnsupportedProtocolVersionError',data:{requested:String(meta['io.modelcontextprotocol/protocolVersion']),supported:[VERSION]}}})
 if(method==='server/discover')return Promise.resolve(result(id,{supportedVersions:[VERSION],
  capabilities:{tools:{},resources:{},prompts:{}},instructions:'DSH mobile tools; stateful operations require explicit user consent.',
  _meta:{'io.modelcontextprotocol/serverInfo':{name:'dsh-mobile-toolbox',version:'4.0.0'}}}))
 if(method==='resources/list'&&context)return Promise.resolve(result(id,context.listResources()))
 if(method==='resources/templates/list'&&context)return Promise.resolve(result(id,context.listResourceTemplates()))
 if(method==='resources/read'&&context)return Promise.resolve().then(()=>context.readResource(request.params||{})).then(v=>result(id,v)).catch(e=>error(id,-32602,e.message))
 if(method==='prompts/list'&&context)return Promise.resolve(result(id,context.listPrompts()))
 if(method==='prompts/get'&&context)return Promise.resolve().then(()=>context.getPrompt(request.params||{})).then(v=>result(id,v)).catch(e=>error(id,-32602,e.message))
 if(method==='tools/list')return Promise.resolve(result(id,{tools:list()}))
 if(method==='tools/call'){
  if(typeof request.params?.name!=='string'||!request.params.name)
   return Promise.resolve(error(id,-32602,'Tool name required'))
  return Promise.resolve().then(()=>execute(request.params.name,request.params.arguments||{}))
   .then(value=>result(id,{content:[{type:'text',text:checkedJson(value)}],structuredContent:value}))
   .catch(ex=>result(id,{isError:true,content:[{type:'text',text:String(ex?.message||'Tool failed').slice(0,300)}]}))
 }
 return Promise.resolve(error(id,-32601,'Method not found'))
}
export async function startModernStdio({list,execute,context,input=process.stdin,output=process.stdout}){
 let running=0
 const lines=createInterface({input,crlfDelay:Infinity})
 for await(const line of lines){
  if(!line.trim())continue
  if(Buffer.byteLength(line)>262144){
   output.write(checkedJson(error(null,-32700,'Request too large'))+'\n');continue
  }
  if(running>=4){let id=null;try{id=JSON.parse(line)?.id??null}catch{}output.write(checkedJson(error(id,-32000,'Server busy'))+'\n');continue}
  let request
  try{request=JSON.parse(line)}catch{
   output.write(checkedJson(error(null,-32700,'Parse error'))+'\n');continue
  }
  running++
  void handleModernRequest(request,{list,execute,context})
   .then(response=>output.write(checkedJson(response)+'\n'))
   .catch(()=>output.write(checkedJson(error(request?.id??null,-32603,'Internal error'))+'\n'))
   .finally(()=>{running--})
 }
}
