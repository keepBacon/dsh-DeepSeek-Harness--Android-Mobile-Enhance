#!/usr/bin/env node
import assert from 'node:assert/strict'
import {mkdtemp,readFile,writeFile,mkdir,rm} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {codeAstTools,codeAstCall} from './dsh-code-engine-ast.mjs'

assert.deepEqual(codeAstTools.map(x=>x.name),['code_ast_symbols','code_ast_references','code_ast_rename','code_ast_prepare_rename','code_ast_diagnostics','code_ast_project_symbols'])
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
 const outline=await codeAstCall('code_ast_project_symbols',{file:api,projectFiles:[entry,other],query:'welcome'})
 assert.ok(outline.symbols.some(x=>x.file===api&&x.name==='welcome'))
 const prepare=await codeAstCall('code_ast_prepare_rename',{file:api,line:2,column:17,projectFiles:[entry,other]})
 assert.equal(prepare.canRename,true)
 assert.equal(prepare.name,'welcome')
 assert.ok(prepare.referenceCount>=2)
 const syntax=await codeAstCall('code_ast_diagnostics',{file:api,projectFiles:[entry,other]})
 assert.equal(syntax.ok,true)
 await writeFile(other,'const invalid: = 1;\n')
 const broken=await codeAstCall('code_ast_diagnostics',{file:other,semantic:false,maxResults:5})
 assert.equal(broken.ok,false)
 assert.ok(broken.total>0)
 await writeFile(other,'const unrelated = 1\n')
 // Cached snapshots must be refreshed when a file is modified externally.
 const fresh=await codeAstCall('code_ast_symbols',{file:other})
 assert.ok(fresh.symbols.some(x=>x.name==='unrelated'))
 await writeFile(other,'const renamedExternally = 2\n')
 const refreshed=await codeAstCall('code_ast_symbols',{file:other})
 assert.ok(refreshed.symbols.some(x=>x.name==='renamedExternally'))
 assert.ok(!refreshed.symbols.some(x=>x.name==='unrelated'))
 console.log('[DSH] TypeScript AST and language-service code editing: OK')
}finally{await rm(root,{recursive:true,force:true})}
