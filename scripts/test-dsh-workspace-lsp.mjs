#!/usr/bin/env node
import assert from 'node:assert/strict'
import {mkdtemp,writeFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {lspExchange,lspCall,lspTools} from './dsh-workspace-lsp.mjs'
const root=await mkdtemp(join(tmpdir(),'dsh-p1-lsp-'))
const mock=new URL('./mock-lsp-server.mjs',import.meta.url).pathname
const source=join(root,'example.cpp')
try{
 await writeFile(source,'int answer() { return 42; }\n')
 for(const action of ['definition','references','documentSymbols']){
  const answer=await lspExchange({command:process.execPath,args:[mock],root,file:source,language:'cpp',action,line:1,column:6,timeoutMs:3000})
  assert.equal(answer.precision,'language-server')
  assert.equal(answer.result.length,1)
 }
 // An unresponsive backend must terminate at the declared deadline;
 // the next language-server invocation must still work.
 await assert.rejects(lspExchange({command:process.execPath,args:['-e','setInterval(()=>{},1000)'],
  root,file:source,language:'cpp',action:'definition',timeoutMs:1000}),/timeout/)
 const recovered=await lspExchange({command:process.execPath,args:[mock],root,file:source,
  language:'cpp',action:'definition',timeoutMs:3000})
 assert.equal(recovered.result.length,1)
 assert.equal(lspTools.length,2)
 const status=await lspCall('workspace_lsp_status',{})
 assert.ok(status.backends.some(x=>x.backend==='clangd'))
 await assert.rejects(lspCall('workspace_lsp_query',{root,file:join(tmpdir(),'outside.cpp'),action:'definition'}),/ENOENT|outside/i)
 console.log('[DSH] P1 bounded language-server JSON-RPC handshake, definitions, references and symbols: OK')
}finally{await rm(root,{recursive:true,force:true})}
