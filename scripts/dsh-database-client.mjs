import {readFile} from 'node:fs/promises'
import http from 'node:http'

/** Model tools never receive broker auth tokens or raw filesystem access. */
export async function databaseCall(payload) {
 const path=process.env.DSH_DATABASE_ENDPOINT_FILE
 if(!path)throw Error('Database broker not configured. Restart the Android host.')
 const endpoint=JSON.parse(await readFile(path,'utf8'))
 if(!Number.isInteger(endpoint.port)||endpoint.port<1024||endpoint.port>65535||
    typeof endpoint.token!=='string'||endpoint.token.length<25)throw Error('Invalid host broker endpoint')
 const data=JSON.stringify(payload)
 if(Buffer.byteLength(data)>16000)throw Error('Database request exceeds limit')
 return await new Promise((resolve,reject)=>{
  const request=http.request({host:'127.0.0.1',port:endpoint.port,path:'/database',method:'POST',
   headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(data),'X-DSH-Token':endpoint.token},
   timeout:49000},response=>{
    const chunks=[];let size=0
    response.on('data',x=>{size+=x.length;if(size>1024*1024){request.destroy(Error('Database response too large'));return}chunks.push(x)})
    response.on('end',()=>{try{const v=JSON.parse(Buffer.concat(chunks).toString('utf8'));if(response.statusCode!==200||!v.ok)reject(Error(v.error||'Database request denied'));else resolve(v)}catch(e){reject(e)}})
   })
  request.on('timeout',()=>request.destroy(Error('Database confirmation timeout')))
  request.on('error',reject)
  request.end(data)
 })
}
if(process.argv.includes('--self-test')&&process.argv[1]&&import.meta.url.endsWith('/'+process.argv[1].split('/').at(-1))) {
 databaseCall({op:'list'}).then(()=>process.exit(0),()=>process.stdout.write('[DSH] database broker requires active host: OK\n'))
}
