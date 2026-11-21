#!/usr/bin/env node
// Real executable regression for DSH 0.2.2 attachment publication paths:
// Android hard-link denial, copy fallback, same-hash deduplication and
// conflicting-hash rejection. No actual app data is accessed.
import assert from 'node:assert/strict'
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createHash} from 'node:crypto'
import {spawnSync} from 'node:child_process'
import {pathToFileURL} from 'node:url'
const root=await mkdtemp(join(tmpdir(),'dsh-android-attachment-022-'))
const pkg=join(root,'lib/node_modules/@deepseek-ai/dsh-attachment-local')
const digest=s=>createHash('sha256').update(s).digest('hex')
try{
 await mkdir(join(pkg,'lib'),{recursive:true})
 await writeFile(join(pkg,'package.json'),JSON.stringify({name:'@deepseek-ai/dsh-attachment-local',version:'0.2.2-rc.5',type:'module'}))
 const source=`import {open,readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const link=async (_src,dest)=>{const e=Object.assign(new Error('denied'),{code:dest.endsWith('.io')?'EIO':'EACCES'});throw e;};
const digestFile=async path=>createHash('sha256').update(await readFile(path)).digest('hex');
export async function publishImmutableAlias(source,target,sha256){
 try {await link(source, target)}
 catch(error) {
  if(error?.code!=='EEXIST')throw error;
  if(await digestFile(target)!==sha256)throw Error('ATTACHMENT_CORRUPT');
 }
}
export async function publishStagedObject(staged,target){
 try {await link(staged.path, target)}
 catch(error) {
  if(error?.code!=='EEXIST')throw error;
  if(await digestFile(target)!==staged.sha256)throw Error('ATTACHMENT_CORRUPT');
 }
}`
 await writeFile(join(pkg,'lib/index.js'),source)
 const patch=()=>spawnSync(process.execPath,['scripts/android-runtime-patch.mjs',root],{
   cwd:new URL('..',import.meta.url).pathname,
   env:{...process.env,DSH_TARGET_VERSION:'0.2.2-rc.5',
     DSH_COMPAT_ONLY_PACKAGES:'@deepseek-ai/dsh-attachment-local'},encoding:'utf8'})
 const first=patch()
 assert.equal(first.status,0,'attachment compatibility patch failed: '+first.stderr)
 const result=JSON.parse(first.stdout).patches.filter(x=>x.name==='@deepseek-ai/dsh-attachment-local')
 assert.equal(result.length,2, 'new 0.2.2 and legacy directory-fsync passes both report')
 assert.equal(result[0].status,'patched')
 assert.ok(['patched','already'].includes(result[1].status))
 const contents=await readFile(join(pkg,'lib/index.js'),'utf8')
 assert.match(contents,/await dshAndroidAttachmentLinkOrCopy\(source, target\)/)
 assert.match(contents,/await dshAndroidAttachmentLinkOrCopy\(staged.path, target\)/)
 assert.match(contents,/copyFile\(source, target, 1\)/)
 const again=patch()
 assert.equal(again.status,0,'repeat attachment patch failed: '+again.stderr)
 const repeat=JSON.parse(again.stdout).patches.filter(x=>x.name==='@deepseek-ai/dsh-attachment-local')
 assert.equal(repeat.length,2)
 assert.ok(repeat.every(x=>x.status==='already'))
 const mod=await import(pathToFileURL(join(pkg,'lib/index.js')).href)
 const staged=join(root,'staged'),alias=join(root,'alias')
 await writeFile(staged,'attachment bytes')
 await mod.publishStagedObject({path:staged,sha256:digest('attachment bytes')},join(root,'stored'))
 assert.equal(await readFile(join(root,'stored'),'utf8'),'attachment bytes')
 await mod.publishImmutableAlias(staged,alias,digest('attachment bytes'))
 assert.equal(await readFile(alias,'utf8'),'attachment bytes')
 await mod.publishImmutableAlias(staged,alias,digest('attachment bytes'))
 await assert.rejects(mod.publishImmutableAlias(staged,alias,digest('different bytes')),/ATTACHMENT_CORRUPT/)
 assert.equal(await readFile(alias,'utf8'),'attachment bytes')
 await assert.rejects(mod.publishImmutableAlias(staged,join(root,'fail.io'),digest('attachment bytes')),{code:'EIO'})
 console.log('[DSH] immutable attachment Android hard-link fallback, alias, EEXIST integrity and error propagation OK')
}finally{await rm(root,{recursive:true,force:true})}
