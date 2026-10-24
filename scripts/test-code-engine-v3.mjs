#!/usr/bin/env node
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { codeV3Tools, codeV3Call } from './dsh-code-engine-v3.mjs'
assert.equal(codeV3Tools.length,3)
assert.equal(new Set(codeV3Tools.map(x=>x.name)).size,3)
const root=await mkdtemp(join(tmpdir(),'dsh-code3-'))
const a=join(root,'a.js'),b=join(root,'b.ts'),bad=join(root,'bad.js')
try{
 const initial="const oldName = oldName; // oldName\nconst label = 'oldName';\nconst regex = /oldName+/;\n"
 await writeFile(a,initial);await writeFile(b,'const oldName: number = 1;\n')
 const preview=await codeV3Call('code_rename_identifier',{paths:[a,b],from:'oldName',to:'newName',dryRun:true})
 assert.equal(preview.scopeAware,false);assert.equal(preview.files.length,2);assert.equal(await readFile(a,'utf8'),initial)
 const applied=await codeV3Call('code_rename_identifier',{paths:[a,b],from:'oldName',to:'newName'})
 assert.equal(applied.files.filter(x=>x.occurrences>0).length,2)
 const changed=await readFile(a,'utf8')
 assert.match(changed,/const newName = newName/);assert.match(changed,/\/\/ oldName/);assert.match(changed,/'oldName'/);assert.match(changed,/\/oldName\+\//)
 assert.match(await readFile(b,'utf8'),/newName: number/)
 await assert.rejects(codeV3Call('code_rename_identifier',{paths:[a],from:'newName',to:'class'}),/invalid identifier/)
 await assert.rejects(codeV3Call('code_rename_identifier',{paths:[a],from:'newName',to:'other',expectedSha256ByPath:{[a]:'0'.repeat(64)}}),/stale source hash/)
 await writeFile(bad,'const = ;\n')
 const check=await codeV3Call('code_check',{paths:[a,bad]})
 assert.equal(check.ok,false);assert.equal(check.results.length,2);assert.equal(check.results.find(x=>x.path===a).ok,true);assert.equal(check.results.find(x=>x.path===bad).ok,false)
 const command=await codeV3Call('code_test',{command:process.execPath,args:['-e','process.stdout.write("test-ok"); process.stderr.write("warn");']})
 assert.equal(command.ok,true);assert.equal(command.stdout,'test-ok');assert.equal(command.stderr,'warn')
 const failed=await codeV3Call('code_test',{command:process.execPath,args:['-e','process.exit(7)']})
 assert.equal(failed.exitCode,7);assert.equal(failed.ok,false)
 const timeout=await codeV3Call('code_test',{command:process.execPath,args:['-e','setTimeout(()=>{},3000)'],timeoutMs:100})
 assert.equal(timeout.timedOut,true);assert.equal(timeout.ok,false)
 console.log('[DSH] Code Engine V3 contract: OK')
}finally{await rm(root,{recursive:true,force:true})}
