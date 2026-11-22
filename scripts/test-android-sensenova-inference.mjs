#!/usr/bin/env node
import assert from 'node:assert/strict'
import {createServer} from 'node:http'
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {spawnSync} from 'node:child_process'
import {fileURLToPath} from 'node:url'
import {androidSenseNovaCompletionsFetch,androidNativeModelStreamingFetch} from './dsh-android-sensenova-completions.mjs'

const saved=new Map()
for(const k of ['DSH_ANDROID_STANDALONE','HTTPS_PROXY','https_proxy','HTTP_PROXY',
  'http_proxy','ALL_PROXY','all_proxy']) {
 saved.set(k,process.env[k]); delete process.env[k]
}
const originalFetch=globalThis.fetch
const root=mkdtempSync(join(tmpdir(),'dsh-sensenova-'))
let server
try {
 const fixture=join(root,'lib/node_modules/@deepseek-ai/dsh-llm-pi-ai')
 mkdirSync(join(fixture,'lib'),{recursive:true})
 writeFileSync(join(fixture,'package.json'),JSON.stringify({name:'@deepseek-ai/dsh-llm-pi-ai'}))
 writeFileSync(join(fixture,'lib/index.js'),[
  'function profileOptions(profile, reasoning, apiKey) {',
  '  return {',
  '    maxRetries: 0,',
  '  }',
  '}',
  'function mapStopReason(message, contextWindow) {return {kind:"stop"}}',
  'async function discoverModels(url) {',
  '  let response;',
  '  try {response = await fetch(url, {method:"GET"})}',
  '  catch(error) {throw new Error(`could not reach ${url}`,{cause:error})}',
  '  return response;',
  '}',
 ].join('\n'))
 const patcher=fileURLToPath(new URL('./android-runtime-patch.mjs',import.meta.url))
 const env={...process.env,DSH_TARGET_VERSION:'0.2.2-rc.5',
  DSH_COMPAT_ONLY_PACKAGES:'@deepseek-ai/dsh-llm-pi-ai'}
 const patched=spawnSync(process.execPath,[patcher,root],{env,encoding:'utf8',timeout:30000})
 assert.equal(patched.status,0,patched.stdout+'\n'+patched.stderr)
 const source=readFileSync(join(fixture,'lib/index.js'),'utf8')
 assert.match(source,/DSH Android compat: SenseNova scoped streaming transport/)
 assert.match(source,/fetch: androidSenseNovaCompletionsFetch/)
 const again=spawnSync(process.execPath,[patcher,root],{env,encoding:'utf8',timeout:30000})
 assert.equal(again.status,0,again.stdout+'\n'+again.stderr)
 assert.equal(readFileSync(join(fixture,'lib/index.js'),'utf8'),source,'bundle patch idempotence')

 server=createServer((req,res)=>{
  assert.equal(req.url,'/v1/chat/completions')
  assert.equal(req.headers.authorization,'Bearer local-test-key')
  assert.equal(req.method,'POST')
  const chunks=[]
  req.on('data',chunk=>chunks.push(chunk))
  req.on('end',()=>{
   assert.equal(JSON.parse(Buffer.concat(chunks).toString()).model,'deepseek-v4-flash')
   res.writeHead(200,{'content-type':'text/event-stream'})
   res.write('data: {"choices":[{"delta":{"content":"hello"}}]}\n\n')
   setTimeout(()=>res.end('data: [DONE]\n\n'),5)
  })
 })
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
 const url='http://127.0.0.1:'+server.address().port+'/v1/chat/completions'
 const reply=await androidNativeModelStreamingFetch(url,{
  method:'POST',headers:{authorization:'Bearer local-test-key','content-type':'application/json'},
  body:JSON.stringify({model:'deepseek-v4-flash',stream:true}),
 })
 assert.equal(reply.status,200)
 assert.match(await reply.text(),/hello/)
 assert.match(source,/token\\\.sensenova/) // runtime scope is exact host, not all providers
 process.env.DSH_ANDROID_STANDALONE='1'
 globalThis.fetch=async()=>{throw Object.assign(new TypeError('transport fail'),{code:'ECONNRESET'})}
 await assert.rejects(androidSenseNovaCompletionsFetch(
  'https://example.com/v1/chat/completions',{method:'POST',body:'{}'}),/transport fail/)
 await assert.rejects(androidSenseNovaCompletionsFetch(
  'https://token.sensenova.cn/v1/other',{method:'POST',body:'{}'}),/transport fail/)
 process.env.HTTPS_PROXY='http://localhost:8899'
 await assert.rejects(androidSenseNovaCompletionsFetch(
  'https://token.sensenova.cn/v1/chat/completions',{method:'POST',body:'{}'}),/transport fail/)
 delete process.env.HTTPS_PROXY
 const c=new AbortController(); c.abort()
 await assert.rejects(androidSenseNovaCompletionsFetch(
  'https://token.sensenova.cn/v1/chat/completions',{method:'POST',body:'{}',signal:c.signal}),
  /transport fail/)
 console.log('[DSH] SenseNova Android stream transport scoped, SSE readable, proxy safe and bundle patch idempotent')
} finally {
 globalThis.fetch=originalFetch
 await new Promise(resolve=>server?.close(resolve) ?? resolve())
 for(const [k,v] of saved) if(v===undefined) delete process.env[k]; else process.env[k]=v
 rmSync(root,{recursive:true,force:true})
}
