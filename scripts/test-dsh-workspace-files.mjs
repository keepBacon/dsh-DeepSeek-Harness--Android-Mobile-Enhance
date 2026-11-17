#!/usr/bin/env node
import assert from 'node:assert/strict'
import {mkdtemp,mkdir,writeFile,readFile,rm,lstat,symlink,readdir} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createHash} from 'node:crypto'
const home=await mkdtemp(join(tmpdir(),'dsh-p2-files-'))
process.env.DSH_WORKSPACE_JOURNAL_DIR=join(home,'journals')
const {projectFileCall,projectFileTools}=await import('./dsh-workspace-files.mjs')
const root=join(home,'repo')
const hash=s=>createHash('sha256').update(s).digest('hex')
try{
 await mkdir(join(root,'src'),{recursive:true})
 const original=join(root,'src','original.ts')
 await writeFile(original,'export const p2 = 1\n')
 assert.equal(projectFileTools.length,2)
 const dry=await projectFileCall('workspace_refactor',{root,dryRun:true,operations:[{type:'create',path:'src/new.ts',content:'export const created = true\n'}]})
 assert.equal(dry.ok,true)
 await assert.rejects(lstat(join(root,'src/new.ts')),{code:'ENOENT'})
 const created=await projectFileCall('workspace_refactor',{root,operations:[{type:'create',path:'src/new.ts',content:'export const created = true\n'}]})
 assert.equal(created.ok,true)
 assert.match(await readFile(join(root,'src/new.ts'),'utf8'),/created/)
 const moved=await projectFileCall('workspace_refactor',{root,operations:[{type:'move',path:'src/new.ts',to:'src/renamed.ts',expectedSha256:hash('export const created = true\n')}]})
 assert.equal(moved.ok,true)
 assert.match(await readFile(join(root,'src/renamed.ts'),'utf8'),/created/)
 await assert.rejects(lstat(join(root,'src/new.ts')),{code:'ENOENT'})
 await assert.rejects(projectFileCall('workspace_refactor',{root,operations:[{type:'delete',path:'src/renamed.ts',expectedSha256:'0'.repeat(64)}]}),/stale source hash/)
 const del=await projectFileCall('workspace_refactor',{root,operations:[{type:'delete',path:'src/renamed.ts',expectedSha256:hash('export const created = true\n')}]})
 assert.equal(del.ok,true)
 await assert.rejects(lstat(join(root,'src/renamed.ts')),{code:'ENOENT'})
 await assert.rejects(projectFileCall('workspace_refactor',{root,operations:[{type:'create',path:'../escape.ts',content:'bad'}]}),/within the project/)
 await assert.rejects(projectFileCall('workspace_refactor',{root,operations:[{type:'move',path:'src/original.ts',to:'src/missing/target.ts'}]}),/ENOENT/)
 const outside=join(home,'outside')
 await mkdir(outside)
 await symlink(outside,join(root,'link'))
 await assert.rejects(projectFileCall('workspace_refactor',{root,operations:[{type:'create',path:'link/evil.ts',content:'bad'}]}),/directory parent/)
 assert.equal(await readFile(original,'utf8'),'export const p2 = 1\n')
 const edited=await projectFileCall('workspace_refactor',{root,operations:[
  {type:'replace',path:'src/original.ts',expectedSha256:hash('export const p2 = 1\n'),
   content:'export const p2 = 2\n'},
  {type:'create',path:'src/added.ts',content:'export const added = true\n'}]})
 assert.equal(edited.ok,true)
 assert.equal(await readFile(original,'utf8'),'export const p2 = 2\n')
 assert.match(await readFile(join(root,'src/added.ts'),'utf8'),/added/)
 await assert.rejects(projectFileCall('workspace_refactor',{root,operations:[
   {type:'replace',path:'src/original.ts',expectedSha256:hash('export const p2 = 1\n'),
    content:'export const p2 = 3\n'}]}),/stale source hash/)
 // Simulate a stopped process after a file was deleted but before journal
 // commit. The recovery tool must restore the exact preimage.
 const journalHash=hash(await (await import('node:fs/promises')).realpath(root))
 const manualDir=join(process.env.DSH_WORKSPACE_JOURNAL_DIR,journalHash,'simulated-crash')
 await mkdir(manualDir,{recursive:true})
 const before=await readFile(original)
 await writeFile(join(manualDir,'file-0.bak'),before)
 const manifest={version:1,id:'simulated-crash',root:await (await import('node:fs/promises')).realpath(root),
  phase:'applying',createdAt:new Date().toISOString(),
  actions:[{type:'delete',from:original,to:null,oldHash:hash(before),afterHash:hash(before),
    mode:0o644,size:before.length,backup:'file-0.bak'}]}
 await writeFile(join(manualDir,'manifest.json'),JSON.stringify(manifest))
 await rm(original)
 const previewRecover=await projectFileCall('workspace_refactor_recover',{root,dryRun:true})
 assert.ok(previewRecover.transactions.some(x=>x.status==='recovery-available'))
 await assert.rejects(lstat(original),{code:'ENOENT'})
 const realRecover=await projectFileCall('workspace_refactor_recover',{root})
 assert.ok(realRecover.ok)
 assert.deepEqual(await readFile(original),before)
 const journals=await projectFileCall('workspace_refactor_recover',{root})
 assert.equal(journals.ok,true)
 assert.equal(journals.transactions.length,0)
 await writeFile(join(root,'pyproject.toml'),'[build-system]\nrequires=[]\n')
 const invalidProject=await projectFileCall('workspace_refactor',{root,system:'python',verify:true,runTests:false,
  timeoutMs:15000,operations:[{type:'create',path:'src/invalid.py',content:'def invalid(:\n'}]})
 assert.equal(invalidProject.ok,false)
 assert.equal(invalidProject.verification.failedPhase,'build')
 assert.equal(invalidProject.rollback.ok,true)
 await assert.rejects(lstat(join(root,'src/invalid.py')),{code:'ENOENT'})
 const verifiedProject=await projectFileCall('workspace_refactor',{root,system:'python',verify:true,runTests:false,
  timeoutMs:15000,operations:[{type:'create',path:'src/valid.py',content:'def valid():\n return True\n'}]})
 assert.equal(verifiedProject.ok,true)
 assert.equal(verifiedProject.verification.ok,true)
 assert.match(await readFile(join(root,'src/valid.py'),'utf8'),/def valid/)

 assert.equal(await readFile(original,'utf8'),'export const p2 = 2\n')
 console.log('[DSH] P2 project-file transaction create/move/delete/dry-run/concurrency/path safety: OK')
}finally{await rm(home,{recursive:true,force:true})}
