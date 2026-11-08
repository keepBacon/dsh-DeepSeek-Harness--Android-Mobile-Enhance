#!/usr/bin/env node
import assert from 'node:assert/strict'
import {mkdtemp,mkdir,writeFile,readFile,rm,symlink} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {createServer} from 'node:http'
import {join} from 'node:path'
import {basicToolCall} from './dsh-basic-toolbox-mcp.mjs'
const root=await mkdtemp(join(tmpdir(),'dsh-basic-ops-'))
const call=(name,args)=>basicToolCall(name,args)
try{
 const source=join(root,'source.txt'),dest=join(root,'dest.txt'),second=join(root,'second.txt')
 await writeFile(source,'new content')
 await writeFile(dest,'old content')
 await assert.rejects(call('file_copy',{source,destination:source,overwrite:true}),/differ/)
 assert.equal(await readFile(source,'utf8'),'new content')
 await assert.rejects(call('file_copy',{source,destination:dest}),/destination exists/)
 assert.equal(await readFile(dest,'utf8'),'old content')
 await call('file_copy',{source,destination:dest,overwrite:true})
 assert.equal(await readFile(dest,'utf8'),'new content')
 const link=join(root,'link.txt')
 await symlink(dest,link)
 await assert.rejects(call('file_copy',{source,destination:link,overwrite:true}),/symlink/)
 assert.equal(await readFile(dest,'utf8'),'new content')
 await assert.rejects(call('file_move',{source:dest,destination:dest,overwrite:true}),/differ/)
 assert.equal(await readFile(dest,'utf8'),'new content')
 const dir=join(root,'directory')
 await mkdir(dir)
 await assert.rejects(call('file_move',{source:dir,destination:join(dir,'nested'),overwrite:true}),/ancestor/)
 // A failed replacement of an existing directory by a file must preserve both paths.
 const occupied=join(root,'occupied')
 await mkdir(occupied)
 await writeFile(join(occupied,'child.txt'),'keep')
 await assert.rejects(call('file_move',{source,destination:occupied,overwrite:true}))
 assert.equal(await readFile(source,'utf8'),'new content')
 assert.equal(await readFile(join(occupied,'child.txt'),'utf8'),'keep')
 // A failed multi-file validation must leave every file unchanged.
 await writeFile(source,'old text')
 await writeFile(dest,'does not match')
 await assert.rejects(call('text_replace',{paths:[source,dest],oldText:'old',newText:'new'}),/expected 1, found 0/)
 assert.equal(await readFile(source,'utf8'),'old text')
 assert.equal(await readFile(dest,'utf8'),'does not match')
 await assert.rejects(call('text_replace',{paths:[source,source],oldText:'old',newText:'new'}),/duplicate/)
 await assert.rejects(call('text_replace',{paths:[source],oldText:'',newText:'new'}),/empty/)
 const malformed=join(root,'malformed.txt'),binary=join(root,'binary.txt')
 await writeFile(malformed,Buffer.from([0xff,0xfe,0x61]))
 await writeFile(binary,Buffer.from([0x61,0x00,0x62]))
 await assert.rejects(call('text_replace',{paths:[source,malformed],oldText:'old',newText:'new'}),/UTF-8/)
 assert.equal(await readFile(source,'utf8'),'old text')
 await assert.rejects(call('text_replace',{paths:[source,binary],oldText:'old',newText:'new'}),/binary/)
 assert.equal(await readFile(source,'utf8'),'old text')
 await writeFile(second,'old text')
 const dry=await call('text_replace',{paths:[source,second],oldText:'old',newText:'new',dryRun:true})
 assert.equal(dry.dryRun,true)
 assert.equal(await readFile(second,'utf8'),'old text')
 const ok=await call('text_replace',{paths:[source,second],oldText:'old',newText:'new'})
 assert.equal(ok.files.length,2)
 assert.equal(await readFile(source,'utf8'),'new text')
 assert.equal(await readFile(second,'utf8'),'new text')
 // Failed downloads must never leave a partial visible file or replace old bytes.
 const downloaded=join(root,'downloaded.bin')
 await writeFile(downloaded,'old download')
 const server=createServer((req,res)=>{
  if(req.url==='/fail'){res.writeHead(503);res.end('upstream unavailable');return}
  if(req.url==='/large'){res.writeHead(200,{'Content-Type':'application/octet-stream'});res.end('x'.repeat(2048));return}
  res.writeHead(200,{'Content-Type':'application/octet-stream'});res.end('new payload')
 })
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve)})
 try{
  const base='http://127.0.0.1:'+server.address().port
  await assert.rejects(call('http_download',{url:base+'/fail',destination:downloaded,overwrite:true}),/curl failed/)
  assert.equal(await readFile(downloaded,'utf8'),'old download')
  await assert.rejects(call('http_download',{url:base+'/large',destination:downloaded,overwrite:true,maxBytes:16}),/curl failed|download exceeds/)
  assert.equal(await readFile(downloaded,'utf8'),'old download')
  await assert.rejects(call('http_download',{url:base+'/ok',destination:downloaded}),/destination exists/)
  assert.equal((await call('http_download',{url:base+'/ok',destination:downloaded,overwrite:true})).size,11)
  assert.equal(await readFile(downloaded,'utf8'),'new payload')
  const fresh=join(root,'fresh-download.txt')
  assert.equal((await call('http_download',{url:base+'/ok',destination:fresh})).size,11)
  assert.equal(await readFile(fresh,'utf8'),'new payload')
 }finally{server.closeAllConnections();await new Promise(done=>server.close(done))}
 // Archive failures leave the old destination intact, including its children.
 const archive=join(root,'not-an-archive.7z'),extract=join(root,'extracted')
 await writeFile(archive,'not a valid archive')
 await mkdir(extract)
 await writeFile(join(extract,'keep.txt'),'original')
 await assert.rejects(call('archive_extract',{path:archive,destination:extract,overwrite:true}))
 assert.equal(await readFile(join(extract,'keep.txt'),'utf8'),'original')
 // The destination cannot be traversed through an existing symlink.
 const extractLink=join(root,'extract-symlink')
 await symlink(extract,extractLink)
 await assert.rejects(call('archive_extract',{path:archive,destination:extractLink,overwrite:true}),/symlink/)
 assert.equal(await readFile(join(extract,'keep.txt'),'utf8'),'original')
 console.log('[DSH] basic file tools regression: OK')
}finally{await rm(root,{recursive:true,force:true})}
