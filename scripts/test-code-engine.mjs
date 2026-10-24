#!/usr/bin/env node
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { codeTools, codeCall } from './dsh-code-engine.mjs'

assert.equal(codeTools.length,4)
assert.equal(new Set(codeTools.map(x=>x.name)).size,4)
const root=await mkdtemp(join(tmpdir(),'dsh-code2-'))
const one=join(root,'one.js'),two=join(root,'two.js')
const sha=s=>createHash('sha256').update(s).digest('hex')
try{
 await writeFile(one,'const one = 1;\n')
 await writeFile(two,'const two = 2;\n')
 const ctx=await codeCall('code_context',{path:one})
 assert.equal(ctx.sha256,sha('const one = 1;\n'))
 assert.match(ctx.content,/1 \| const one = 1/)
 const sr=await codeCall('code_search',{path:root,query:'const one'})
 assert.ok(sr.matches.some(x=>x.path.endsWith('one.js')))
 const dry=await codeCall('code_patch',{path:one,oldText:'one = 1',newText:'one = 3',dryRun:true})
 assert.equal(dry.dryRun,true)
 assert.equal(await readFile(one,'utf8'),'const one = 1;\n')
 await assert.rejects(codeCall('code_patch',{path:one,oldText:'one = 1',newText:'one = 3',expectedSha256:'0'.repeat(64)}),/stale source hash/)
 await codeCall('code_patch',{path:one,oldText:'one = 1',newText:'one = 3'})
 assert.equal(await readFile(one,'utf8'),'const one = 3;\n')
 await assert.rejects(codeCall('code_multi_edit',{edits:[
   {path:one,oldText:'one = 3',newText:'one = 4'},
   {path:two,oldText:'missing-anchor',newText:'two = 4'},
 ]}),/context must occur exactly once/)
 assert.equal(await readFile(one,'utf8'),'const one = 3;\n')
 await codeCall('code_multi_edit',{edits:[
   {path:one,oldText:'one = 3',newText:'one = 4'},
   {path:one,oldText:'one = 4',newText:'one = 5'},
   {path:two,oldText:'two = 2',newText:'two = 5'},
 ]})
 assert.equal(await readFile(one,'utf8'),'const one = 5;\n')
 assert.equal(await readFile(two,'utf8'),'const two = 5;\n')
 await assert.rejects(codeCall('code_multi_edit',{edits:[
   {path:one,oldText:'one = 5',newText:'one = 6'},
   {path:two,oldText:'two = 5',newText:'two = 6',expectedSha256:'f'.repeat(64)},
 ]}),/stale source hash/)
 assert.equal(await readFile(one,'utf8'),'const one = 5;\n')
 console.log('[DSH] Code Engine 2.0 editing contract: OK')
}finally{await rm(root,{recursive:true,force:true})}
