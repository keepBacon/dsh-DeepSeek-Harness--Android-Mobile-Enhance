import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const code=readFileSync('app/src/main/java/com/dshmobile/shell/MainActivity.kt','utf8')
const a=code.indexOf("        let lastWorkspaceSyncKey = '';")
const b=code.indexOf('\n        const directChildUnder =',a)
assert.ok(a>0&&b>a,'workspace synchronization implementation absent')
const source=code.slice(a,b)
assert.ok(!source.includes('document.querySelectorAll("input")'),'do not inspect typed content')
let selected='s1',now=100000,requestCount=0,bridgePaths=[]
let respond=()=>Promise.resolve({ok:true,json:async()=>({result:{ok:true,value:{items:[{sessionId:selected,cwd:'/workspace/'+selected}]}}})})
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r});return {promise,resolve}}
const timeoutFns=new Map();let nextTimer=0
const fakeTimeout=(fn,ms)=>{
  assert.equal(ms,6000,'bounded model-independent session RPC timeout')
  const id=++nextTimer;timeoutFns.set(id,fn);return id
}
const fakeClear=(id)=>{timeoutFns.delete(id)}
const fetch=async (_url,options)=>{
  requestCount++
  assert.equal(options.method,'POST')
  assert.equal(options.credentials,'include')
  assert.ok(options.signal instanceof AbortSignal)
  return respond(options)
}
const document={
  baseURI:'http://127.0.0.1:3080/',
  querySelector(){return {getAttribute(){return 'session:'+selected}}}
}
const location={pathname:'/'}
const window={androidBridge:{setCurrentWorkspacePath(_cap,cwd){bridgePaths.push(cwd);return true}}}
class DateMock extends Date {static now(){return now}}
const create=new Function('document','location','fetch','window','BRIDGE_CAP',
  'setTimeout','clearTimeout','queueMicrotask','Date','Math','URL','AbortController',
  source+'\nreturn {syncActiveWorkspace};')
const {syncActiveWorkspace}=create(document,location,fetch,window,'cap',fakeTimeout,
  fakeClear,queueMicrotask,DateMock,Math,URL,AbortController)
const tick=()=>new Promise(done=>setImmediate(done))
await syncActiveWorkspace()
assert.deepEqual(bridgePaths,['/workspace/s1'])
assert.equal(requestCount,1)
assert.equal(timeoutFns.size,0)
await syncActiveWorkspace()
assert.equal(requestCount,1,'unrelated clicks should not re-list sessions')
now+=5001
await syncActiveWorkspace()
assert.equal(requestCount,2,'a later refresh should be allowed')
assert.deepEqual(bridgePaths,['/workspace/s1'],'unchanged workspace must not reset bridge')

const inFlight=deferred()
selected='s2'
respond=()=>inFlight.promise
const staleRequest=syncActiveWorkspace()
await tick()
assert.equal(requestCount,3)
selected='s3'
const switched=syncActiveWorkspace()
assert.equal(requestCount,3,'no concurrent RPC while prior request in flight')
await switched
respond=()=>Promise.resolve({ok:true,json:async()=>({result:{ok:true,value:{items:[{sessionId:'s3',cwd:'/workspace/s3'}]}}})})
inFlight.resolve({ok:true,json:async()=>({result:{ok:true,value:{items:[{sessionId:'s2',cwd:'/workspace/s2'}]}}})})
await staleRequest
await tick()
assert.equal(requestCount,4,'a queued session switch should be synchronized')
assert.deepEqual(bridgePaths,['/workspace/s1','/workspace/s3'],
 'stale session results must never mutate bridge workspace')
assert.equal(timeoutFns.size,0)

const hanging=deferred()
selected='s4'
respond=({signal})=>new Promise((_resolve,reject)=>{
  signal.addEventListener('abort',()=>reject(new Error('aborted')),{once:true})
})
const aborting=syncActiveWorkspace()
await tick()
assert.equal(requestCount,5)
assert.equal(timeoutFns.size,1)
for(const fn of timeoutFns.values())fn()
await aborting
assert.equal(timeoutFns.size,0,'request timeouts must be released')
selected='s5'
respond=()=>Promise.resolve({ok:true,json:async()=>({result:{ok:true,value:{items:[{sessionId:'s5',cwd:'/workspace/s5'}]}}})})
await syncActiveWorkspace()
assert.deepEqual(bridgePaths,['/workspace/s1','/workspace/s3','/workspace/s5'],
 'abort must release the synchronization lock')
console.log('[DSH] workspace sync de-duplication, timeout, session-switch race and retry: OK')
