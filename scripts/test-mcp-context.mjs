import {mkdtemp,mkdir,writeFile,symlink,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createMcpContext} from './dsh-mcp-context.mjs'
import {handleModernRequest} from './dsh-mcp-modern-stdio.mjs'
const assert=(x,m)=>{if(!x)throw Error(m)}
const root=await mkdtemp(join(tmpdir(),'dsh-context-'))
try{
 await mkdir(join(root,'src'));await writeFile(join(root,'src','main.js'),'const apple=1;\nconst banana=2;\n')
 await symlink('/etc/passwd',join(root,'src','escape'))
 const ctx=createMcpContext({workspace:root})
 assert(ctx.listResources().resources.length===4,'resources')
 assert(ctx.listResourceTemplates().resourceTemplates.length===2,'templates')
 assert(ctx.listPrompts().prompts.length===5,'prompts')
 const read=await ctx.readResource({uri:'dsh://workspace/file/src/main.js?startLine=2&maxLines=1'})
 assert(read.contents[0].text.includes('banana'),'resource read')
 let rejected=false;try{await ctx.readResource({uri:'dsh://workspace/file/src/escape'})}catch{rejected=true}assert(rejected,'symlink traversal')
 rejected=false;try{await ctx.readResource({uri:'dsh://workspace/file/%2e%2e/%2e%2e/etc/passwd'})}catch{rejected=true}assert(rejected,'path traversal')
 assert(ctx.getPrompt({name:'safe-patch',arguments:{goal:'compile'}}).messages.length===1,'prompt')
 const budget=ctx.contextBudget({text:'apple\nbanana\ncherry',query:'banana',maxChars:256})
 assert(budget.selectedLines===1&&budget.inputSha256.length===64,'context budget')
 const saf=join(root,'saf');await mkdir(saf)
 const safText='Selected user document\\nSecond line'
 const safId='saf-'+'1'.repeat(32)
 const safHash=(await import('node:crypto')).createHash('sha256').update(safText).digest('hex')
 await writeFile(join(saf,safId+'.txt'),safText)
 await writeFile(join(saf,'index.json'),JSON.stringify({schema:1,documents:[{id:safId,name:'User text',sizeBytes:Buffer.byteLength(safText),sha256:safHash,addedAt:1}]}))
 const authorized=createMcpContext({workspace:root,safDir:saf})
 const safList=await authorized.readResource({uri:'dsh://android/saf'})
 assert(JSON.parse(safList.contents[0].text).documents.length===1,'SAF list')
 const safRead=await authorized.readResource({uri:'dsh://android/saf/'+safId})
 assert(safRead.contents[0].text.includes('Selected user document'),'SAF resource read')
 let denied=false
 try{await authorized.readResource({uri:'dsh://android/saf/saf-'+ '2'.repeat(32)})}catch{denied=true}
 assert(denied,'unapproved SAF id readable')
 await writeFile(join(saf,safId+'.txt'),'TAMPER')
 denied=false;try{await authorized.readResource({uri:'dsh://android/saf/'+safId})}catch{denied=true}
 assert(denied,'SAF hash tamper undetected')
 const android=await ctx.nativeSnapshot();assert(android.root==='not-probed','no privilege claims')
 const meta={'io.modelcontextprotocol/protocolVersion':'2026-07-28','io.modelcontextprotocol/clientCapabilities':{}}
 const rpc=await handleModernRequest({jsonrpc:'2.0',id:1,method:'resources/list',params:{_meta:meta}},
  {list:()=>[],execute:async()=>{},context:ctx})
 assert(rpc.result?.resources?.length===3,'modern route')
 const promptRpc=await handleModernRequest({jsonrpc:'2.0',id:2,method:'prompts/get',
  params:{_meta:meta,name:'safe-patch',arguments:{goal:'fix workflow'}}},
  {list:()=>[],execute:async()=>{},context:ctx})
 assert(promptRpc.result?.messages?.length===1,'modern prompt route')
 const readRpc=await handleModernRequest({jsonrpc:'2.0',id:3,method:'resources/read',
  params:{_meta:meta,uri:'dsh://workspace/file/src/main.js?startLine=1&maxLines=1'}},
  {list:()=>[],execute:async()=>{},context:ctx})
 assert(readRpc.result?.contents?.[0]?.mimeType==='text/plain','modern read route')

 console.log('[DSH] MCP P2 Resources/Prompts/Android context self-test: OK')
}finally{await rm(root,{recursive:true,force:true})}
