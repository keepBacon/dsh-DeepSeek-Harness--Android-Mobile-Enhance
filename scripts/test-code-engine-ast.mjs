#!/usr/bin/env node
import assert from 'node:assert/strict'
import {mkdtemp,readFile,writeFile,mkdir,rm} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {codeAstTools,codeAstCall} from './dsh-code-engine-ast.mjs'

assert.deepEqual(codeAstTools.map(x=>x.name),['code_ast_symbols','code_ast_references','code_ast_rename'])
const root=await mkdtemp(join(tmpdir(),'dsh-code-ast-'))
try{
 await mkdir(join(root,'lib'))
 const api=join(root,'lib','api.ts'),entry=join(root,'app.ts'),other=join(root,'other.ts')
 const original=[
  'export const shared = 3',
  'export function greet(name: string) { return shared + name.length }',
  '',
 ].join('\n')
 const client=[
  "import {greet} from './lib/api'",
  "const result = greet('sam')",
  'function separate(greet: number) { return greet + 1 }',
  'console.log(result, separate(1))',
  '',
 ].join('\n')
 await writeFile(api,original)
 await writeFile(entry,client)
 await writeFile(other,'const unrelated = 1\n')
 const symbols=await codeAstCall('code_ast_symbols',{file:api})
 const declaration=symbols.symbols.find(x=>x.name==='greet'&&x.kind==='function')
 assert.ok(declaration,'function declaration missing from AST')
 assert.equal(declaration.line,2)
 assert.equal(symbols.strategy,'typescript-ast')
 const location={file:api,line:declaration.line,column:declaration.column,projectFiles:[entry,other]}
 const refs=await codeAstCall('code_ast_references',location)
 assert.ok(refs.locations.some(x=>x.path===entry),'missing cross-file reference')
 assert.ok(!refs.locations.some(x=>x.path===other),'unrelated file shown as reference')
 const before=await codeAstCall('code_ast_rename',{...location,newName:'welcome',dryRun:true})
 assert.equal(before.dryRun,true)
 assert.equal(before.scopeAware,true)
 assert.equal(await readFile(api,'utf8'),original)
 assert.equal(await readFile(entry,'utf8'),client)
 const actual=await codeAstCall('code_ast_rename',{...location,newName:'welcome'})
 assert.equal(actual.dryRun,false)
 assert.match(await readFile(api,'utf8'),/function welcome\(name/)
 const updated=await readFile(entry,'utf8')
 assert.match(updated,/import \{welcome\}/)
 assert.match(updated,/welcome\('sam'\)/)
 assert.match(updated,/function separate\(greet: number\)/)
 assert.match(updated,/return greet \+ 1/)
 assert.equal(await readFile(other,'utf8'),'const unrelated = 1\n')
 await assert.rejects(codeAstCall('code_ast_rename',{...location,newName:'class'}),/cannot rename|identifier|rename/i)
 await assert.rejects(codeAstCall('code_ast_references',{file:api,line:999,column:1,projectFiles:[entry]}),/line out of source range/)
 console.log('[DSH] TypeScript AST and language-service code editing: OK')
}finally{await rm(root,{recursive:true,force:true})}
