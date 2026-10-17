import {mkdtemp,writeFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createServer} from 'node:http'
import {databaseCall} from './dsh-database-client.mjs'

const work=await mkdtemp(join(tmpdir(),'dsh-database-mcp-'))
const token='0'.repeat(40)
let seen=0
const server=createServer(async(req,res)=>{
 const body=[]
 for await(const chunk of req)body.push(chunk)
 const json=JSON.parse(Buffer.concat(body).toString('utf8'))
 if(req.method!=='POST'||req.url!=='/database'||req.headers['x-dsh-token']!==token)throw Error('Unauthorized request')
 if(json.op==='search'&&json.query==='example'){seen++}
 const response=JSON.stringify({ok:true,results:[{id:'test',title:'test'}]})
 res.setHeader('content-type','application/json')
 res.end(response)
})
try {
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
 const path=join(work,'endpoint.json')
 await writeFile(path,JSON.stringify({port:server.address().port,token}))
 const before=process.env.DSH_DATABASE_ENDPOINT_FILE
 process.env.DSH_DATABASE_ENDPOINT_FILE=path
 try{
  const r=await databaseCall({op:'search',query:'example'})
  if(!r.ok||r.results[0].id!=='test'||seen!==1)throw Error('database client bridge failed')
  let denied=false
  try{await databaseCall({op:'search',query:'x'.repeat(20000)})}catch(e){denied=/exceeds limit/.test(String(e.message))}
  if(!denied)throw Error('oversized request not blocked')
 }finally{
  if(before===undefined)delete process.env.DSH_DATABASE_ENDPOINT_FILE
  else process.env.DSH_DATABASE_ENDPOINT_FILE=before
 }
 process.stdout.write('[DSH] database MCP loopback client integration: OK\n')
}finally{
 await new Promise(resolve=>server.close(resolve))
 await rm(work,{recursive:true,force:true})
}
