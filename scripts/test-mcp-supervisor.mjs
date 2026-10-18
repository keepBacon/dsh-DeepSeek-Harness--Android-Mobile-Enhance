import {EventEmitter} from 'node:events'
import {PassThrough} from 'node:stream'
import {createMcpSupervisor} from './dsh-mcp-supervisor.mjs'
const assert=(value,message)=>{if(!value)throw Error(message)}
const out=[],children=[]
function fakeChild(){
 const child=new EventEmitter()
 child.stdin=new PassThrough()
 child.stdout=new PassThrough()
 child.stderr=new PassThrough()
 child.written=''
 child.stdin.on('data',b=>{child.written+=b.toString()})
 child.kill=()=>child.emit('close',null)
 children.push(child)
 return child
}
const supervisor=createMcpSupervisor({entry:'/fake/server.mjs',spawnChild:fakeChild,send:line=>out.push(JSON.parse(line)),log:()=>{}})
supervisor.start()
assert(children.length===1,'initial spawn')
supervisor.accept(JSON.stringify({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-11-25'}}))
supervisor.accept(JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'}))
supervisor.accept(JSON.stringify({jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'write'}}))
assert(supervisor.state().pending===2,'in flight tracking')
children[0].emit('close',1)
assert(out.some(x=>x.id===2&&x.error?.code===-32003),'inflight side effect not failed')
assert(!out.some(x=>x.id===2&&x.result),'fake result')
await new Promise(resolve=>setTimeout(resolve,310))
assert(children.length===2,'no reconnect')
assert(children[1].written.includes('dsh-init-'),'missing handshake replay')
assert(!children[1].written.includes('tools/call'),'side effect replayed')
const init=JSON.parse(children[1].written.trim().split('\n')[0])
children[1].stdout.write(JSON.stringify({jsonrpc:'2.0',id:init.id,result:{capabilities:{tools:{}}}})+'\n')
await new Promise(resolve=>setTimeout(resolve,20))
assert(supervisor.state().ready,'recovery handshake')
assert(children[1].written.includes('notifications/initialized'),'initialized notification missing')
supervisor.stop()
console.log('[DSH] MCP child reconnect with in-flight rejection: OK')
