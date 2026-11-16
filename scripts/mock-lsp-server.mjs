#!/usr/bin/env node
// Deterministic in-repo LSP fixture for protocol regression. No external LSP needed.
let pending=Buffer.alloc(0)
function send(obj){
 const data=Buffer.from(JSON.stringify(obj))
 process.stdout.write('Content-Length: '+data.length+'\r\n\r\n')
 process.stdout.write(data)
}
process.stdin.on('data',chunk=>{
 pending=Buffer.concat([pending,chunk])
 while(true){
  const end=pending.indexOf('\r\n\r\n')
  if(end<0)break
  const match=/Content-Length:\s*(\d+)/i.exec(pending.subarray(0,end).toString('ascii'))
  if(!match)process.exit(7)
  const size=Number(match[1])
  if(pending.length<end+4+size)break
  const msg=JSON.parse(pending.subarray(end+4,end+4+size).toString('utf8'))
  pending=pending.subarray(end+4+size)
  if(msg.method==='initialize')send({jsonrpc:'2.0',id:msg.id,result:{capabilities:{definitionProvider:true}}})
  else if(msg.method==='textDocument/definition'||msg.method==='textDocument/references')
   send({jsonrpc:'2.0',id:msg.id,result:[{uri:msg.params.textDocument.uri,range:{start:{line:0,character:4},end:{line:0,character:10}}}]})
  else if(msg.method==='textDocument/documentSymbol')
   send({jsonrpc:'2.0',id:msg.id,result:[{name:'answer',kind:12,range:{start:{line:0,character:0},end:{line:0,character:30}},selectionRange:{start:{line:0,character:4},end:{line:0,character:10}}}]})
 }
})
