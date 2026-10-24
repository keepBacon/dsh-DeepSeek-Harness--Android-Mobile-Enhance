#!/usr/bin/env node
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { codeTools, codeCall } from './dsh-code-engine.mjs'

assert.equal(codeTools.length,8)
assert.equal(new Set(codeTools.map(x=>x.name)).size,8)
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
 const decl=await codeCall('code_symbols',{path:root})
 assert.ok(decl.symbols.some(x=>x.name==='one'))
 const refs=await codeCall('code_references',{path:root,symbol:'one'})
 assert.ok(refs.matches.some(x=>x.path.endsWith('one.js')))
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
 // A generated unified diff must round-trip through the same engine.
 const proposal='const one = 7;\n'
 const unified=await codeCall('code_diff',{path:one,after:proposal})
 assert.equal(unified.changed,true)
 assert.ok(unified.patch.includes('@@ -1,'))
 const simulate=await codeCall('code_apply_patch',{root,patch:unified.patch,dryRun:true})
 assert.equal(simulate.dryRun,true)
 assert.equal(await readFile(one,'utf8'),'const one = 5;\n')
 await codeCall('code_apply_patch',{root,patch:unified.patch})
 assert.equal(await readFile(one,'utf8'),proposal)
 await assert.rejects(codeCall('code_apply_patch',{root,patch:unified.patch}),/hunk context mismatch/)
 await assert.rejects(codeCall('code_apply_patch',{root,patch:unified.patch.replaceAll('one.js','../escape.js')}),/invalid patch path/)
 // Test multiple consecutive ---/+++ headers in a single unified patch.
 const another=await codeCall('code_diff',{path:two,after:'const two = 8;\n'})
 const updatedOne=await codeCall('code_diff',{path:one,after:'const one = 9;\n'})
 const combined=updatedOne.patch+another.patch
 const multiDry=await codeCall('code_apply_patch',{root,patch:combined,dryRun:true})
 assert.equal(multiDry.files.length,2)
 await codeCall('code_apply_patch',{root,patch:combined})
 assert.equal(await readFile(one,'utf8'),'const one = 9;\n')
 assert.equal(await readFile(two,'utf8'),'const two = 8;\n')
 console.log('[DSH] Code Engine 2.0 editing contract: OK')
}finally{await rm(root,{recursive:true,force:true})}
