#!/usr/bin/env node
// Behavioral regression: Android model discovery (DSH 0.2.2) must recover
// Node fetch transport failures without leaking keys or bypassing proxies.
import assert from 'node:assert/strict'
import {createServer} from 'node:http'
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {spawnSync} from 'node:child_process'
import {fileURLToPath} from 'node:url'
import {androidModelDiscoveryFetch,androidModelDiscoveryFailureHint} from './dsh-android-model-discovery-fallback.mjs'

const root=mkdtempSync(join(tmpdir(),'dsh-model-discovery-'))
const script=fileURLToPath(new URL('./android-runtime-patch.mjs',import.meta.url))
const preserved=new Map()
for(const k of ['DSH_ANDROID_STANDALONE','HTTPS_PROXY','https_proxy','HTTP_PROXY',
 'http_proxy','ALL_PROXY','all_proxy']) {
 preserved.set(k,process.env[k])
 delete process.env[k]
}
const originalFetch=globalThis.fetch
let server
try {
 const fixture=join(root,'lib/node_modules/@deepseek-ai/dsh-llm-pi-ai')
 mkdirSync(join(fixture,'lib'),{recursive:true})
 writeFileSync(join(fixture,'package.json'),JSON.stringify({name:'@deepseek-ai/dsh-llm-pi-ai'}))
 writeFileSync(join(fixture,'lib/index.js'),[
  'function profileOptions(profile, reasoning, apiKey) { return { maxRetries: 0 }; }',
  'function mapStopReason(message, contextWindow) { return { kind: "stop" }; }',
  'async function discoverModels(url) {',
  '  let response;',
  '  try { response = await fetch(url, { method: "GET", headers: {} }); }',
  '  catch (error) { throw new Error(`could not reach ${url}`, { cause: error }); }',
  '  return response;',
  '}',
 ].join('\n'))
 const env={...process.env,DSH_TARGET_VERSION:'0.2.2-rc.5',
  DSH_COMPAT_ONLY_PACKAGES:'@deepseek-ai/dsh-llm-pi-ai'}
 const patch=spawnSync(process.execPath,[script,root],{env,encoding:'utf8',timeout:30000})
 assert.equal(patch.status,0,patch.stdout+'\n'+patch.stderr)
 const updated=readFileSync(join(fixture,'lib/index.js'),'utf8')
 assert.match(updated,/DSH Android compat: model discovery native transport fallback/)
 assert.match(updated,/response = await androidModelDiscoveryFetch\(url, \{/)
 assert.match(updated,/androidModelDiscoveryFailureHint\(error\)/)
 const again=spawnSync(process.execPath,[script,root],{env,encoding:'utf8',timeout:30000})
 assert.equal(again.status,0,again.stdout+'\n'+again.stderr)
 assert.equal(readFileSync(join(fixture,'lib/index.js'),'utf8'),updated,
  'patch must be idempotent')
 server=createServer((req,res)=>{
  assert.equal(req.url,'/v1/models')
  assert.equal(req.headers.authorization,'Bearer test-local-key')
  res.writeHead(200,{'content-type':'application/json'})
  res.end(JSON.stringify({data:[{id:'deepseek-v4-flash'}]}))
 })
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
 const url='http://127.0.0.1:'+server.address().port+'/v1/models'
 globalThis.fetch=async()=>{throw Object.assign(new Error('fetch transport unavailable'),
  {code:'UND_ERR_SOCKET'})}
 process.env.DSH_ANDROID_STANDALONE='1'
 const response=await androidModelDiscoveryFetch(url,{method:'GET',
  headers:{authorization:'Bearer test-local-key'}})
 assert.equal(response.status,200)
 assert.deepEqual((await response.json()).data.map(x=>x.id),['deepseek-v4-flash'])
 // Explicitly configured proxy policy must not silently become a direct
 // credential-bearing request to a different network path.
 process.env.HTTP_PROXY='http://127.0.0.1:8899'
 await assert.rejects(
  androidModelDiscoveryFetch(url,{method:'GET',headers:{authorization:'Bearer test-local-key'}}),
  /fetch transport unavailable/)
 delete process.env.HTTP_PROXY
 const cancelled=new AbortController()
 cancelled.abort()
 await assert.rejects(androidModelDiscoveryFetch(url,{method:'GET',signal:cancelled.signal}),
  /fetch transport unavailable/)
 const err=new Error('sensitive key: secret-value')
 err.code='ECONNRESET'
 assert.equal(androidModelDiscoveryFailureHint(err),'Node transport: ECONNRESET')
 assert.ok(!androidModelDiscoveryFailureHint(err).includes('secret-value'))
 console.log('[DSH] Android 0.2.2 model listing: native GET fallback, no proxy bypass, idempotent bundle patch OK')
} finally {
 globalThis.fetch=originalFetch
 await new Promise(resolve=>server?.close(resolve) ?? resolve())
 for(const [k,v] of preserved) if(v===undefined) delete process.env[k]; else process.env[k]=v
 rmSync(root,{recursive:true,force:true})
}
