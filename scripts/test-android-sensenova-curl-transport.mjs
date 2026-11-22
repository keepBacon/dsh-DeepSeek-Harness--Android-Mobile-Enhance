#!/usr/bin/env node
// Real OS curl fixture for SenseNova model listing and SSE inference.
// No online API key or vendor endpoint is called.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync, rmSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { androidCurlAvailable, androidCurlRequest } from './dsh-android-curl-transport.mjs'
import { androidSenseNovaCompletionsFetch } from './dsh-android-sensenova-completions.mjs'

const curl = execFileSync('/bin/sh',['-c','command -v curl'],{encoding:'utf8'}).trim()
assert.ok(curl.startsWith('/'), 'Linux curl executable required for native transport fixture')
const root = mkdtempSync(join(tmpdir(), 'dsh-sensenova-curl-'))
const wrappedCurl = join(root,'curl-with-private-argv-audit.sh')
const argLog = join(root,'argv.log')
// Linux has no /system/bin/sh. Exercise the genuine native curl executable
// through an argv-auditing wrapper. The Android linker route has separate
// Android source/ABI acceptance gates.
writeFileSync(wrappedCurl, '#!/bin/sh\nprintf "%s\\n" "$@" > "$DSH_CURL_TEST_ARGV_LOG"\nexec '+JSON.stringify(curl)+' "$@"\n')
chmodSync(wrappedCurl,0o700)
const saved = new Map()
const envNames = ['DSH_ANDROID_STANDALONE','DSH_ANDROID_CURL_BINARY',
  'DSH_ANDROID_EXEC_BRIDGE','DSH_CURL_TEST_ARGV_LOG',
  'HTTPS_PROXY','https_proxy','HTTP_PROXY','http_proxy','ALL_PROXY','all_proxy']
for(const name of envNames){saved.set(name,process.env[name]);delete process.env[name]}
let server
let requests = []
try {
  server = createServer((req,res)=>{
    const chunks = []
    req.on('data',chunk=>chunks.push(chunk))
    req.on('end',()=>{
      requests.push({method:req.method,path:req.url,headers:req.headers,
        body:Buffer.concat(chunks).toString('utf8')})
      if(req.url==='/v1/models'){
        res.writeHead(200,{'content-type':'application/json'})
        res.end(JSON.stringify({data:[{id:'glm-5.3'},{id:'deepseek-v4.1-flash'}]}))
      }else if(req.url==='/v1/chat/completions'){
        res.writeHead(200,{'content-type':'text/event-stream'})
        res.write('data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n')
        setTimeout(()=>res.end('data: [DONE]\n\n'),15)
      }else if(req.url==='/v1/missing'){
        res.writeHead(401,{'content-type':'application/json'})
        res.end(JSON.stringify({error:{message:'invalid key'}}))
      }else{res.writeHead(404);res.end()}
    })
  })
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
  const base='http://127.0.0.1:'+server.address().port
  process.env.DSH_ANDROID_STANDALONE='0'
  process.env.DSH_ANDROID_CURL_BINARY=wrappedCurl
  process.env.DSH_CURL_TEST_ARGV_LOG=argLog
  assert.equal(await androidCurlAvailable(),true)
  const secret='test-secret-only-in-pipe-7642'
  const found=await androidCurlRequest(base+'/v1/models',{
    method:'GET',headers:{authorization:'Bearer '+secret}
  })
  assert.equal(found.status,200)
  assert.deepEqual((await found.json()).data.map(x=>x.id),['glm-5.3','deepseek-v4.1-flash'])
  assert.equal(requests[0].headers.authorization,'Bearer '+secret)
  assert.equal(requests[0].method,'GET')

  const reply=await androidCurlRequest(base+'/v1/chat/completions',{
    method:'POST',headers:{authorization:'Bearer '+secret,'content-type':'application/json'},
    body:JSON.stringify({model:'glm-5.3',stream:true,messages:[{role:'user',content:'ping'}]})
  })
  assert.equal(reply.status,200)
  assert.match(await reply.text(),/Hello/)
  assert.match(requests[1].body,/"model":"glm-5.3"/)
  assert.equal(requests[1].headers.authorization,'Bearer '+secret)
  assert.equal(requests.filter(x=>x.method==='POST').length,1,'POST must never retry')
  assert.ok(!readFileSync(argLog,'utf8').includes(secret),
    'curl process arguments must never contain credentials')
  assert.ok(!readFileSync(argLog,'utf8').includes('"model"'),
    'curl process arguments must never contain completion payload')

  const missing=await androidCurlRequest(base+'/v1/missing',{method:'GET'})
  assert.equal(missing.status,401,'non-2xx HTTP status must reach the caller')
  const bad=new AbortController();bad.abort()
  await assert.rejects(androidCurlRequest(base+'/v1/models',{signal:bad.signal}),/cancelled/)
  await assert.rejects(androidCurlRequest('ftp://localhost/models'),/unsupported model endpoint/)
  const originalFetch=globalThis.fetch
  try{
    globalThis.fetch=async()=>{throw new TypeError('Node fetch transport failed')}
    // The standalone public SenseNova function is not allowed to substitute
    // the fixture endpoint; its eligibility guard must never accept another.
    await assert.rejects(androidSenseNovaCompletionsFetch(base+'/v1/chat/completions',{
      method:'POST',body:'{}'}),/Node fetch transport failed/)
  }finally{globalThis.fetch=originalFetch}
  console.log('[DSH] SenseNova native curl GET/POST wire, SSE, private credentials, no retries, HTTP errors, abort: OK')
}finally{
  await new Promise(resolve=>server?.close(resolve) ?? resolve())
  for(const [name,value] of saved){
    if(value===undefined)delete process.env[name]
    else process.env[name]=value
  }
  rmSync(root,{recursive:true,force:true})
}
