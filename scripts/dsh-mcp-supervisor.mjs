#!/usr/bin/env node
/**
 * Optional stdio MCP crash supervisor. Never replays in-flight tool calls.
 * Launch: node dsh-mcp-supervisor.mjs /absolute/path/to/server.mjs
 * Legacy initialize is replayed only to restore the *protocol handshake*.
 */
import {spawn} from 'node:child_process'
import {createInterface} from 'node:readline'
import {randomBytes} from 'node:crypto'

export function createMcpSupervisor({entry,spawnChild=()=>spawn(process.execPath,[entry],{stdio:['pipe','pipe','pipe'],env:process.env,shell:false}),send=x=>process.stdout.write(x+'\n'),log=x=>process.stderr.write(x+'\n')}){
 if(typeof entry!=='string'||!entry)throw Error('server entry required')
 let child=null,ready=false,closed=false,attempt=0,init=null,initialized=false,restarting=false
 const pending=new Map(),internal='dsh-init-'+randomBytes(12).toString('hex')
 let timer=null
 function replyFailed(id){send(JSON.stringify({jsonrpc:'2.0',id,error:{code:-32003,message:'MCP server restarted; operation not replayed'}}))}
 function start(){
  if(closed)return
  ready=false
  child=spawnChild()
  const current=child
  let stderrBytes=0
  current.stderr.on('data',buf=>{if(stderrBytes<8192){const s=buf.toString('utf8').slice(0,1024);stderrBytes+=s.length;log('[MCP child] '+s)}})
  let buff=''
  current.stdout.on('data',buf=>{
   buff+=buf.toString('utf8')
   if(buff.length>1024*1024){try{current.kill('SIGKILL')}catch{};return}
   for(;;){
    const index=buff.indexOf('\n');if(index<0)break
    const line=buff.slice(0,index);buff=buff.slice(index+1)
    try{
     const message=JSON.parse(line)
     if(message.id===internal){
      if(message.result){ready=true;attempt=0
       if(initialized)current.stdin.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'})+'\n')
      }else{try{current.kill('SIGKILL')}catch{}}
      continue
     }
     if(Object.prototype.hasOwnProperty.call(message,'id'))pending.delete(JSON.stringify(message.id))
    }catch{}
    send(line)
   }
  })
  current.on('error',e=>log('[MCP supervisor] spawn failure: '+String(e.message).slice(0,200)))
  current.on('close',()=>{
   if(current!==child)return
   child=null;ready=false
   for(const id of pending.values())replyFailed(id)
   pending.clear()
   if(closed)return
   const delay=Math.min(10000,250*2**Math.min(attempt++,5))
   timer=setTimeout(()=>{restarting=true;start();restarting=false},delay)
  })
  if(init){
   // Reestablish transport session without reissuing any tool call.
   const request={...init,id:internal}
   current.stdin.write(JSON.stringify(request)+'\n')
  }else ready=true
 }
 function accept(line){
  let message
  try{message=JSON.parse(line)}catch{send(line);return}
  if(!message||typeof message!=='object'){send(line);return}
  if(message.method==='initialize'&&Object.prototype.hasOwnProperty.call(message,'id')){
   init=message;ready=!!child
  }
  if(message.method==='notifications/initialized')initialized=true
  const id=Object.prototype.hasOwnProperty.call(message,'id')?message.id:undefined
  if(!child||!ready){
   if(id!==undefined)replyFailed(id)
   return
  }
  if(id!==undefined)pending.set(JSON.stringify(id),id)
  try{child.stdin.write(line+'\n')}catch{
   if(id!==undefined){pending.delete(JSON.stringify(id));replyFailed(id)}
  }
 }
 function stop(){
  closed=true
  if(timer)clearTimeout(timer)
  if(child){try{child.kill('SIGTERM')}catch{}}
 }
 return{start,accept,stop,state:()=>({connected:!!child,ready,restarting,attempt,pending:pending.size})}
}
async function main(){
 const entry=process.argv[2];if(!entry)throw Error('Usage: dsh-mcp-supervisor.mjs <server-script>')
 const supervisor=createMcpSupervisor({entry})
 supervisor.start()
 const input=createInterface({input:process.stdin,crlfDelay:Infinity})
 for await(const line of input)supervisor.accept(line)
 supervisor.stop()
}
if(process.argv[1]?.endsWith('/dsh-mcp-supervisor.mjs'))main().catch(e=>{process.stderr.write(String(e)+'\n');process.exitCode=1})
