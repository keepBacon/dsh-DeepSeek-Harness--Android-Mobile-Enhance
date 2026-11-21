#!/usr/bin/env node
// Regression: DSH 0.2.2 must create and migrate private zstd sessions even
// when Android rejects hard links. Exclusive publication must not overwrite
// a competing writer's session; no user profile or archive is modified.
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

const prefix=await mkdtemp(join(tmpdir(),'dsh-022-android-session-test-'))
const pkg=join(prefix,'lib/node_modules/@deepseek-ai/dsh-session-persistence-jsonl')
const error=()=>Object.assign(new Error('Android hard links disabled'),{code:'EACCES'})
try {
  await mkdir(join(pkg,'lib'),{recursive:true})
  await writeFile(join(pkg,'package.json'),JSON.stringify({name:'@deepseek-ai/dsh-session-persistence-jsonl',version:'0.2.2-rc.5',type:'module'}))
  const index=`import { open, rm } from 'node:fs/promises';
const link=async()=>{throw Object.assign(new Error('no hardlinks'),{code:'EACCES'});};
export async function materialize(tmp,finalPath) {
  let linked = false;
  try {
    await link(tmp, finalPath);
    linked = true;
  } finally {
    if (!linked) await rm(tmp,{force:true});
  }
  await rm(tmp,{force:true});
}`
  const generation=`import { open as fsOpen } from 'node:fs/promises';
const internals={fs:{link:async()=>{throw Object.assign(new Error('no hardlinks'),{code:'EACCES'});}}};
export async function publishCurrentExclusive(staged,currentPath) {
  try {
    await internals.fs.link(staged, currentPath);
  } catch (error) {
    if (error.code === 'EEXIST') return false;
    throw error;
  }
  return true;
}`
  await writeFile(join(pkg,'lib/index.js'),index)
  await writeFile(join(pkg,'lib/generation.js'),generation)
  const patch=()=>spawnSync(process.execPath,['scripts/android-runtime-patch.mjs',join(prefix,'usr')],{
    cwd:new URL('..',import.meta.url).pathname,
    env:{...process.env,DSH_TARGET_VERSION:'0.2.2-rc.5',DSH_COMPAT_ONLY_PACKAGES:'@deepseek-ai/dsh-session-persistence-jsonl'},
    encoding:'utf8',
  })
  const result=patch()
  assert.equal(result.status,0,'Android patcher failed: '+result.stderr+' '+result.stdout)
  const out=JSON.parse(result.stdout)
  const statuses=out.patches.filter(x=>x.name==='@deepseek-ai/dsh-session-persistence-jsonl')
  assert.equal(statuses.length,2)
  assert.ok(statuses.every(x=>x.status==='patched'))
  assert.match(await readFile(join(pkg,'lib/index.js'),'utf8'),/copyFile\(tmp, finalPath, 1\)/)
  assert.match(await readFile(join(pkg,'lib/generation.js'),'utf8'),/copyFile\(staged, currentPath, 1\)/)
  const again=patch()
  assert.equal(again.status,0,'idempotent patch failed: '+again.stderr)
  assert.ok(JSON.parse(again.stdout).patches.filter(x=>x.name==='@deepseek-ai/dsh-session-persistence-jsonl').every(x=>x.status==='already'))
  const {materialize}=await import(pathToFileURL(join(pkg,'lib/index.js')).href)
  const {publishCurrentExclusive}=await import(pathToFileURL(join(pkg,'lib/generation.js')).href)
  const tmp=join(prefix,'new.tmp'),target=join(prefix,'session.v4.jsonl.zstd')
  await writeFile(tmp,'session data')
  await materialize(tmp,target)
  assert.equal(await readFile(target,'utf8'),'session data')
  const conflict=join(prefix,'conflict.tmp')
  await writeFile(conflict,'new different session')
  await assert.rejects(materialize(conflict,target),{code:'EEXIST'})
  assert.equal(await readFile(target,'utf8'),'session data','must never overwrite competing session')
  const migrated=join(prefix,'current-generation')
  await writeFile(join(prefix,'staged'),'migration bytes')
  assert.equal(await publishCurrentExclusive(join(prefix,'staged'),migrated),true)
  assert.equal(await readFile(migrated,'utf8'),'migration bytes')
  assert.equal(await publishCurrentExclusive(join(prefix,'staged'),migrated),false)
  assert.equal(await readFile(migrated,'utf8'),'migration bytes')
  // Non-permission errors must still surface, rather than being ignored.
  assert.equal(typeof error().code,'string')
  console.log('[DSH] 0.2.2 Android EACCES session materialization: exclusive copy, migration, idempotence OK')
} finally {
  await rm(prefix,{recursive:true,force:true})
}
