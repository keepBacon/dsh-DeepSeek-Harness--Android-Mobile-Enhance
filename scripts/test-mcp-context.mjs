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
 assert(ctx.listResources().resources.length===3,'resources')
 assert(ctx.listResourceTemplates().resourceTemplates.length===1,'templates')
 assert(ctx.listPrompts().prompts.length===5,'prompts')
 const read=await ctx.readResource({uri:'dsh://workspace/file/src/main.js?startLine=2&maxLines=1'})
 assert(read.contents[0].text.includes('banana'),'resource read')
 let rejected=false;try{await ctx.readResource({uri:'dsh://workspace/file/src/escape'})}catch{rejected=true}assert(rejected,'symlink traversal')
 rejected=false;try{await ctx.readResource({uri:'dsh://workspace/file/%2e%2e/%2e%2e/etc/passwd'})}catch{rejected=true}assert(rejected,'path traversal')
 assert(ctx.getPrompt({name:'safe-patch',arguments:{goal:'compile'}}).messages.length===1,'prompt')
 const budget=ctx.contextBudget({text:'apple\nbanana\ncherry',query:'banana',maxChars:256})
 assert(budget.selectedLines===1&&budget.inputSha256.length===64,'context budget')
 const android=await ctx.nativeSnapshot();assert(android.root==='not-probed','no privilege claims')
 const meta={'io.modelcontextprotocol/protocolVersion':'2026-07-28','io.modelcontextprotocol/clientCapabilities':{}}
 const rpc=await handleModernRequest({jsonrpc:'2.0',id:1,method:'resources/list',params:{_meta:meta}},
  {list:()=>[],execute:async()=>{},context:ctx})
 assert(rpc.result?.resources?.length===3,'modern route')
 console.log('[DSH] MCP P2 Resources/Prompts/Android context self-test: OK')
}finally{await rm(root,{recursive:true,force:true})}
