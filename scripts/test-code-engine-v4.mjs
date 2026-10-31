#!/usr/bin/env node
import assert from 'node:assert/strict'
import {mkdtemp,writeFile,mkdir,rm} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {codeV4Tools,codeV4Call} from './dsh-code-engine-v4.mjs'
assert.equal(codeV4Tools.length,3)
const root=await mkdtemp(join(tmpdir(),'dsh-code-v4-'))
try{
 await mkdir(join(root,'lib'))
 await writeFile(join(root,'lib','leaf.ts'),'export const value = 1\n')
 await writeFile(join(root,'service.ts'),"import {value} from './lib/leaf.js'\nexport const service = value\n")
 await writeFile(join(root,'app.ts'),"import {service} from './service'\nexport const app = service\n")
 await writeFile(join(root,'other.ts'),'export const other = 1\n')
 await mkdir(join(root,'.dsh'),{recursive:true})
 await writeFile(join(root,'.dsh','unrelated.ts'),'export const hidden = 1\n')
 await mkdir(join(root,'node_modules'),{recursive:true})
 await writeFile(join(root,'node_modules','hidden.ts'),'export const internal = 1\n')
 const deps=await codeV4Call('code_dependencies',{root,entry:'app.ts'})
 assert.deepEqual(deps.dependencies,['lib/leaf.ts','service.ts'])
 assert.equal(deps.scan.complete,true)
 const depthLimited=await codeV4Call('code_dependencies',{root,maxDepth:1})
 assert.equal(depthLimited.scan.complete,false,'maxDepth must report truncated traversal')
 assert.equal(depthLimited.scan.files,5,'maxDepth must exclude nested source files')
 assert.ok(!deps.files?.some(x=>x.startsWith('.dsh/')||x.startsWith('node_modules/')),'metadata must not be indexed')
 const impact=await codeV4Call('code_impact',{root,changedFiles:['lib/leaf.ts']})
 assert.deepEqual(impact.affectedFiles,['app.ts','service.ts'])
 const other=await codeV4Call('code_impact',{root,changedFiles:['other.ts']})
 assert.deepEqual(other.affectedFiles,[])
 await assert.rejects(codeV4Call('code_impact',{root,changedFiles:['../outside.ts']}),/escapes root/)
 await writeFile(join(root,'verify.js'),'const valid = 1;\n')
 const good=await codeV4Call('code_verify',{paths:[join(root,'verify.js')],command:process.execPath,args:['-e','process.stdout.write("ok")']})
 assert.equal(good.ok,true)
 await writeFile(join(root,'verify.js'),'const = ;\n')
 const bad=await codeV4Call('code_verify',{paths:[join(root,'verify.js')],command:process.execPath,args:['-e','process.exit(1)']})
 assert.equal(bad.failedPhase,'syntax')
 const failed=await codeV4Call('code_verify',{command:process.execPath,args:['-e','process.exit(7)']})
 assert.equal(failed.failedPhase,'test')
 console.log('[DSH] Code Engine V4 graph/verify regression: OK')
}finally{await rm(root,{recursive:true,force:true})}
