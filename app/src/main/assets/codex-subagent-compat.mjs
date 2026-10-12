#!/usr/bin/env node
/**
 * DSH Android: preserve user-approved Codex subagent routing when the parent
 * uses another model provider. Fixes the plugin's missing saved-default
 * fallback without altering tool-defined explicit provider/model selections.
 *
 * No implicit broadening of the Host's per-session allowedModels policy.
 * No credentials or profile settings are read or changed.
 */
import { readFile, writeFile, mkdir, realpath, stat, chmod, rename, mkdtemp, rm, open, readdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'

const MARKER = 'DSH_ANDROID_CODEX_SUBAGENT_SAVED_DEFAULT_V1'
const PACKAGES = ['dsh-codex-subscription', 'dsh-codex-subscription-en', '@mamdouh-aboammar/dsh-codex-subscription']
const sha256 = value => createHash('sha256').update(value).digest('hex')
const anchors = Object.freeze([
  [
    'function subagentThreadPolicy(parent, policy, requested = {}) {',
    'function subagentThreadPolicy(parent, policy, requested = {}, savedDefaultModel) {'
  ],
  [
    'const model = requested.model ?? (selected.provider === "openai-codex" ? selected.model : void 0);',
    'const model = requested.model ?? (selected.provider === "openai-codex" ? selected.model : savedDefaultModel);'
  ],
  [
    'function createSubscriptionSubagent({ ctx, nativeHome, resolveAuth, store, refresh, loadRuntime, maintenance = () => false }) {',
    'function createSubscriptionSubagent({ ctx, nativeHome, resolveAuth, store, refresh, loadRuntime, getSubscriptionDefaultModel, maintenance = () => false }) {'
  ],
  [
    'subagentThreadPolicy(request.parent, ctx.sandboxPolicy.resolve({ session: request.parent.session }), request.agentOptions);',
    'subagentThreadPolicy(request.parent, ctx.sandboxPolicy.resolve({ session: request.parent.session }), request.agentOptions, getSubscriptionDefaultModel());'
  ],
  [
    'loadRuntime: loadSubagentRuntime,',
    'loadRuntime: loadSubagentRuntime,\n\t\t\tgetSubscriptionDefaultModel: () => {\n\t\t\t\tconst saved = defaultModel.status();\n\t\t\t\treturn saved.managed && modelCatalog.getModels().some((model) => model.id === saved.model) ? saved.model : void 0;\n\t\t\t},'
  ]
])
function check(text) {
  const proc = spawnSync(process.execPath, ['--input-type=module','--check'], {input:text,encoding:'utf8',timeout:6000,maxBuffer:2*1024*1024})
  return proc.status === 0 && !proc.error
}
function plan(source) {
  if (source.includes(MARKER)) return { status:'already' }
  if (!source.includes('const SUBAGENT_PROVIDER = "codex-subscription-subagent";')) return {status:'unsupported-plugin'}
  let modified = source
  for (const [from,to] of anchors) {
    const one = modified.indexOf(from)
    if (one < 0 || modified.indexOf(from,one + from.length) >= 0) return {status:'unsupported-version',reason:'required unique source anchor not found'}
    modified = modified.slice(0,one)+to+modified.slice(one + from.length)
  }
  const start = modified.startsWith('#!') ? modified.indexOf('\n')+1 : 0
  modified = modified.slice(0,start)+'// '+MARKER+'\n'+modified.slice(start)
  if(!check(modified))return {status:'syntax-rejected'}
  return {status:'patchable',modified}
}
async function repair(home) {
  const root = resolve(home)
  const report = []
  for (const name of PACKAGES) {
    let file
    try{file=await realpath(join(root,'.dsh/profiles/web/node_modules',name,'lib/index.js'))}
    catch(e){if(e.code!=='ENOENT')report.push({name,status:'unreadable'});continue}
    if(!file.startsWith(root+'/')) {report.push({name,status:'outside-app-home'});continue}
    try {
      const before=await readFile(file,'utf8')
      const next=plan(before)
      if(next.status==='unsupported-plugin')continue
      if(next.status!=='patchable'){report.push({name,status:next.status});continue}
      const hash=sha256(before)
      const directory=join(root,'.dsh/compat-backups')
      await mkdir(directory,{recursive:true,mode:0o700})
      const backup=join(directory,name.replaceAll('/','_').replaceAll('@','')+'-subagent-'+hash.slice(0,24)+'.js')
      try{
        const fd=await open(backup,'wx',0o600)
        try{await fd.writeFile(before)}finally{await fd.close()}
      }catch(e){if(e.code!=='EEXIST')throw e}
      if(sha256(await readFile(backup))!==hash)throw new Error('backup checksum mismatch')
      const staged=file+'.subagent-compat-'+process.pid
      try{
        await writeFile(staged,next.modified,{flag:'wx',mode:0o600})
        await chmod(staged,(await stat(file)).mode&0o777)
        if(sha256(await readFile(file))!==hash)throw Error('plugin file modified concurrently')
        await rename(staged,file)
      }catch(e){await rm(staged,{force:true}).catch(()=>{});throw e}
      report.push({name,status:'patched',originalSha256:hash})
    }catch(e){report.push({name,status:'error',detail:String(e.message||e).slice(0,140)})}
  }
  return report
}
async function selfTest(){
  const root=await mkdtemp(join(tmpdir(),'dsh-subagent-compat-'))
  try {
    const file=join(root,'.dsh/profiles/web/node_modules/dsh-codex-subscription/lib/index.js')
    await mkdir(join(root,'.dsh/profiles/web/node_modules/dsh-codex-subscription/lib'),{recursive:true})
    const snippet = [
      'const SUBAGENT_PROVIDER = "codex-subscription-subagent";',
      'function subagentThreadPolicy(parent, policy, requested = {}) {',
      'const selected = parent.session.requestHeader()?.config ?? parent.options ?? {};',
      'const model = requested.model ?? (selected.provider === "openai-codex" ? selected.model : void 0);',
      'return { model };',
      '}',
      'function createSubscriptionSubagent({ ctx, nativeHome, resolveAuth, store, refresh, loadRuntime, maintenance = () => false }) {',
      'const thread = subagentThreadPolicy(request.parent, ctx.sandboxPolicy.resolve({ session: request.parent.session }), request.agentOptions);',
      '}',
      'function outer() { const instance = createSubscriptionSubagent({',
      'loadRuntime: loadSubagentRuntime,',
      '}); }'
    ].join('\n')+'\n'
    await writeFile(file,snippet)
    const a=await repair(root)
    if(a[0]?.status!=='patched')throw Error('patch not applied: '+JSON.stringify(a))
    const code=await readFile(file,'utf8')
    if(!code.includes(MARKER)||!code.includes('model.id === saved.model')||!check(code))throw Error('patched source invalid')
    const b=await repair(root)
    if(b[0]?.status!=='already')throw Error('patch not idempotent')
    const names=await readdir(join(root,'.dsh/compat-backups'))
    if(names.length!==1 || await readFile(join(root,'.dsh/compat-backups',names[0]),'utf8')!==snippet)throw Error('backup not exact')
    const unrelated=snippet.replace('const model = requested.model ?? (selected.provider === "openai-codex" ? selected.model : void 0);','const model = "static";')
    await writeFile(file,unrelated)
    const c=await repair(root)
    if(c[0]?.status!=='unsupported-version'||await readFile(file,'utf8')!==unrelated)throw Error('unsupported source was modified')
    process.stdout.write('[OK] subagent explicit model priority, account-default fallback, backup and fail closed\n')
  }finally{await rm(root,{recursive:true,force:true})}
}
if(process.argv.includes('--self-test'))await selfTest()
else if(process.argv[2]==='--repair-home'&&process.argv[3]){
  for(const item of await repair(process.argv[3])) process.stdout.write(JSON.stringify(item)+'\n')
}else{process.stderr.write('usage: codex-subagent-compat.mjs --repair-home HOME | --self-test\n');process.exitCode=2}
