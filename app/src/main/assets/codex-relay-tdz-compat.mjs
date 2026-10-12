#!/usr/bin/env node
// Android-only surgical repair of a literal RELAY_DEFAULT_URL TDZ.
// Never remove packages, clear HOME, or touch OAuth credentials/settings.
import { readFile, writeFile, mkdir, realpath, stat, chmod, rename, mkdtemp, rm, readdir, open } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'

const MARKER = '// DSH Android compat: literal RELAY_DEFAULT_URL hoisted'
const PACKAGES = ['dsh-codex-subscription', 'dsh-codex-subscription-en', '@mamdouh-aboammar/dsh-codex-subscription']
const digest = text => createHash('sha256').update(text).digest('hex')
function syntaxOK(text) {
  const r = spawnSync(process.execPath, ['--input-type=module', '--check'], {
    input: text, encoding: 'utf8', timeout: 5000, maxBuffer: 1048576
  })
  return r.status === 0 && !r.error
}
function plan(text) {
  if (text.includes(MARKER)) return { status:'already' }
  const matches = [...text.matchAll(/^(?:const|let) RELAY_DEFAULT_URL\s*=\s*(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')\s*;?[ \t]*$/gm)]
  if (matches.length !== 1) return { status:'unsupported-declaration' }
  const d = matches[0]
  if (!/\bRELAY_DEFAULT_URL\b/.test(text.slice(0,d.index))) return { status:'no-early-reference' }
  const without = text.slice(0,d.index) + text.slice(d.index + d[0].length)
  const shebang = text.startsWith('#!') ? text.indexOf('\n') + 1 : 0
  const updated = without.slice(0,shebang) + MARKER + '\n' + d[0] + '\n' + without.slice(shebang)
  return syntaxOK(updated) ? { status:'repairable', updated } : { status:'syntax-rejected' }
}
async function repair(home) {
  const base = resolve(home)
  const notices = []
  for (const name of PACKAGES) {
    const path = join(base,'.dsh/profiles/web/node_modules',name,'lib/index.js')
    let target
    try { target = await realpath(path) } catch(e) {
      if(e.code !== 'ENOENT') notices.push({package:name,status:'unreadable'})
      continue
    }
    if(!target.startsWith(base+'/')) {
      notices.push({package:name,status:'outside-home-refused'}); continue
    }
    try {
      const before = await readFile(target,'utf8')
      if(!before.includes('RELAY_DEFAULT_URL')) continue
      const attempt = plan(before)
      if(attempt.status !== 'repairable') {
        notices.push({package:name,status:attempt.status}); continue
      }
      const sha = digest(before)
      const dir = join(base,'.dsh/compat-backups')
      await mkdir(dir,{recursive:true,mode:0o700})
      const backup = join(dir,name.replaceAll('/','_').replaceAll('@','')+'-relay-'+sha.slice(0,16)+'.js')
      try {
        const fd = await open(backup,'wx',0o600)
        try { await fd.writeFile(before) } finally { await fd.close() }
      } catch(e) { if(e.code !== 'EEXIST') throw e }
      if(digest(await readFile(backup)) !== sha) throw Error('backup checksum mismatch')
      const temp = target+'.dsh-relay-tmp-'+process.pid
      try {
        await writeFile(temp,attempt.updated,{flag:'wx',mode:0o600})
        await chmod(temp,(await stat(target)).mode & 0o777)
        await rename(temp,target)
      } catch(e) {
        await rm(temp,{force:true}).catch(()=>{})
        throw e
      }
      notices.push({package:name,status:'patched',backupSha256:sha})
    } catch(e) {
      notices.push({package:name,status:'error',reason:String(e.message||e).slice(0,100)})
    }
  }
  return notices
}
async function selfTest() {
  const home = await mkdtemp(join(tmpdir(),'dsh-codex-tdz-'))
  try {
    const dir = join(home,'.dsh/profiles/web/node_modules/dsh-codex-subscription/lib')
    await mkdir(dir,{recursive:true})
    const path = join(dir,'index.js')
    const original = 'import "node:fs";\nexport const relay = RELAY_DEFAULT_URL;\nconst RELAY_DEFAULT_URL = "https://example.invalid";\n'
    await writeFile(path,original)
    const first = await repair(home)
    if(first[0]?.status !== 'patched') throw Error('first repair not applied: '+JSON.stringify(first))
    const result = await readFile(path,'utf8')
    if(result.indexOf('const RELAY_DEFAULT_URL') > result.indexOf('export const relay')) throw Error('TDZ still present')
    if((await repair(home))[0]?.status !== 'already') throw Error('not idempotent')
    const backups = await readdir(join(home,'.dsh/compat-backups'))
    if(backups.length !== 1 || await readFile(join(home,'.dsh/compat-backups',backups[0]),'utf8') !== original) throw Error('backup corruption')
    const unsupported='export const relay = RELAY_DEFAULT_URL;\nconst RELAY_DEFAULT_URL = makeUrl();\n'
    await writeFile(path,unsupported)
    if((await repair(home))[0]?.status !== 'unsupported-declaration') throw Error('unsupported initializer accepted')
    if(await readFile(path,'utf8') !== unsupported) throw Error('unsupported initializer modified')
    process.stdout.write('[OK] Codex relay repair, source backup, idempotence and fail-closed case\n')
  } finally { await rm(home,{recursive:true,force:true}) }
}
if(process.argv.includes('--self-test')) await selfTest()
else if(process.argv[2] === '--repair-home' && process.argv[3]) {
  for(const notice of await repair(process.argv[3])) process.stdout.write(JSON.stringify(notice)+'\n')
} else {
  process.stderr.write('usage: codex-relay-tdz-compat.mjs --repair-home <home> | --self-test\n')
  process.exitCode=2
}
