#!/usr/bin/env node
import assert from 'node:assert/strict'
import {mkdtemp,mkdir,writeFile,readFile,rm,symlink} from 'node:fs/promises'
import {tmpdir} from 'node:os'
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
 await assert.rejects(call('file_move',{source,destination:join(root,'missing','target'),overwrite:true}),/ENOENT|no such file|rename/)
 // A failed multi-file validation must leave every file unchanged.
 await writeFile(source,'old text')
 await writeFile(dest,'does not match')
 await assert.rejects(call('text_replace',{paths:[source,dest],oldText:'old',newText:'new'}),/expected 1, found 0/)
 assert.equal(await readFile(source,'utf8'),'old text')
 assert.equal(await readFile(dest,'utf8'),'does not match')
 await assert.rejects(call('text_replace',{paths:[source,source],oldText:'old',newText:'new'}),/duplicate/)
 await assert.rejects(call('text_replace',{paths:[source],oldText:'',newText:'new'}),/empty/)
 await writeFile(second,'old text')
 const dry=await call('text_replace',{paths:[source,second],oldText:'old',newText:'new',dryRun:true})
 assert.equal(dry.dryRun,true)
 assert.equal(await readFile(second,'utf8'),'old text')
 const ok=await call('text_replace',{paths:[source,second],oldText:'old',newText:'new'})
 assert.equal(ok.files.length,2)
 assert.equal(await readFile(source,'utf8'),'new text')
 assert.equal(await readFile(second,'utf8'),'new text')
 console.log('[DSH] basic file tools regression: OK')
}finally{await rm(root,{recursive:true,force:true})}
