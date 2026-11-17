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
 const journals=await projectFileCall('workspace_refactor_recover',{root})
 assert.equal(journals.ok,true)
 assert.equal(journals.transactions.length,0)
 console.log('[DSH] P2 project-file transaction create/move/delete/dry-run/concurrency/path safety: OK')
}finally{await rm(home,{recursive:true,force:true})}
