#!/usr/bin/env node
import assert from 'node:assert/strict'
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
const home=await mkdtemp(join(tmpdir(),'dsh-p2-edit-verify-'))
process.env.DSH_CODE_ENGINE_STATE_DIR=join(home,'journal')
const {codeWorkflowCall}=await import('./dsh-code-engine-workflow.mjs')
try{
 const root=join(home,'python')
 await mkdir(root)
 const source=join(root,'value.py')
 await writeFile(join(root,'pyproject.toml'),'[build-system]\nrequires=[]\n')
 await writeFile(source,'def value():\n return 4\n')
 await writeFile(join(root,'test_value.py'),
  'import unittest\nfrom value import value\nclass TestValue(unittest.TestCase):\n def test_value(self):\n  self.assertEqual(value(),4)\n')
 const good=await codeWorkflowCall('workspace_edit_verify',{root,system:'python',
  edits:[{path:source,oldText:'return 4',newText:'return 4 # verified'}],
  runTests:true,timeoutMs:30000})
 assert.equal(good.ok,true,JSON.stringify(good))
 assert.match(await readFile(source,'utf8'),/verified/)
 const invalid=await codeWorkflowCall('workspace_edit_verify',{root,system:'python',
  edits:[{path:source,oldText:'return 4 # verified',newText:'return 6'}],
  runTests:true,timeoutMs:30000})
 assert.equal(invalid.ok,false)
 assert.equal(invalid.phase,'test')
 assert.equal(invalid.rollback.ok,true)
 assert.match(await readFile(source,'utf8'),/return 4 # verified/)
 const syntax=await codeWorkflowCall('workspace_edit_verify',{root,system:'python',
  edits:[{path:source,oldText:'return 4 # verified',newText:'return !'}],
  runTests:true,timeoutMs:30000})
 assert.equal(syntax.ok,false)
 assert.equal(syntax.phase,'build')
 assert.equal(syntax.rollback.ok,true)
 assert.match(await readFile(source,'utf8'),/return 4 # verified/)
 const dry=await codeWorkflowCall('workspace_edit_verify',{root,system:'python',
  edits:[{path:source,oldText:'return 4 # verified',newText:'return 10'}],dryRun:true})
 assert.equal(dry.ok,true)
 assert.match(await readFile(source,'utf8'),/return 4 # verified/)
 const other=join(home,'outside.py')
 await writeFile(other,'value = 0\n')
 await assert.rejects(codeWorkflowCall('workspace_edit_verify',{root,
  edits:[{path:other,oldText:'0',newText:'1'}]}),/escapes project root/)
 console.log('[DSH] P2 project edit-build-test durable commit and failure rollback: OK')
}finally{await rm(home,{recursive:true,force:true})}
