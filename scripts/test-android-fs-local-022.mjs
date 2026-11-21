#!/usr/bin/env node
// Test that the signed DSH 0.2.2 fs-local compatibility patch does NOT
// rename a staged file over another writer's new file on Android FUSE.
import assert from 'node:assert/strict'
import {mkdtemp,mkdir,writeFile,readFile,rm,lstat} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {spawnSync} from 'node:child_process'
import {pathToFileURL} from 'node:url'

const prefix=await mkdtemp(join(tmpdir(),'dsh-022-android-fs-local-'))
const pkg=join(prefix,'lib/node_modules/@deepseek-ai/dsh-fs-local')
try{
 await mkdir(join(pkg,'lib'),{recursive:true})
 await writeFile(join(pkg,'package.json'),JSON.stringify({name:'@deepseek-ai/dsh-fs-local',version:'0.2.2-rc.5',type:'module'}))
 const fixture=`import { open, lstat } from 'node:fs/promises';
const isENOENT=e=>e?.code==='ENOENT', isENOTDIR=e=>e?.code==='ENOTDIR';
async function throwGuardedCreateFailure(error, absolutePath, displayPath, inspectPublicationTarget) {
 let existing;
 try {existing=await inspectPublicationTarget(absolutePath)}
 catch(e){if(!isENOENT(e)&&!isENOTDIR(e))throw e}
 if(existing!==undefined)throw Object.assign(new Error('competing writer'),{code:'FS_NOT_OBSERVED'})
 throw error;
}
export async function createIfAbsentFile(tempPath,absolutePath,deny='EACCES') {
 const createIfAbsent={displayPath:absolutePath};
 const inspectPublicationTarget=path=>lstat(path);
 try {
  throw Object.assign(new Error('hardlink rejected'),{code:deny});
 } catch(error) {
  await throwGuardedCreateFailure(error, absolutePath, createIfAbsent.displayPath, inspectPublicationTarget);
 }
}`
 await writeFile(join(pkg,'lib/index.js'),fixture)
 const run=()=>spawnSync(process.execPath,['scripts/android-runtime-patch.mjs',prefix],{
  cwd:new URL('..',import.meta.url).pathname,
  env:{...process.env,DSH_TARGET_VERSION:'0.2.2-rc.5',DSH_COMPAT_ONLY_PACKAGES:'@deepseek-ai/dsh-fs-local'},
  encoding:'utf8'
 })
 const first=run()
 assert.equal(first.status,0,'fs-local Android patch failed: '+first.stderr)
 const patches=JSON.parse(first.stdout).patches.filter(x=>x.name==='@deepseek-ai/dsh-fs-local')
 assert.equal(patches.length,1)
 assert.equal(patches[0].status,'patched')
 const patched=await readFile(join(pkg,'lib/index.js'),'utf8')
 assert.match(patched,/copyFile\(tempPath, absolutePath, 1\)/)
 assert.doesNotMatch(patched,/await rename\(tempPath, absolutePath\)/)
 const second=run()
 assert.equal(second.status,0,'repeat patch failed: '+second.stderr)
 assert.equal(JSON.parse(second.stdout).patches.filter(x=>x.name==='@deepseek-ai/dsh-fs-local')[0].status,'already')
 const {createIfAbsentFile}=await import(pathToFileURL(join(pkg,'lib/index.js')).href)
 const tmp=join(prefix,'staged.tmp'),dest=join(prefix,'user-project.txt')
 await writeFile(tmp,'new project file')
 await createIfAbsentFile(tmp,dest)
 assert.equal(await readFile(dest,'utf8'),'new project file')
 const competitor=join(prefix,'another-user-project.txt')
 await writeFile(competitor,'must be retained')
 await assert.rejects(createIfAbsentFile(tmp,competitor),{code:'FS_NOT_OBSERVED'})
 assert.equal(await readFile(competitor,'utf8'),'must be retained')
 const errorFile=join(prefix,'io-fault.txt')
 await assert.rejects(createIfAbsentFile(tmp,errorFile,'EIO'),{code:'EIO'})
 await assert.rejects(lstat(errorFile),{code:'ENOENT'})
 console.log('[DSH] fs-local Android create-if-absent fallback: no overwrite, idempotent, error classification OK')
}finally{await rm(prefix,{recursive:true,force:true})}
