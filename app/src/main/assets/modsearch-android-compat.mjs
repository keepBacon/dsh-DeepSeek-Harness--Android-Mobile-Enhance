#!/usr/bin/env node
// Android-only compatibility for the original @liustack/modsearch DSH bundle.
// No replacement tools, providers or credentials are installed. The only
// change is where the ORIGINAL plugin's CLI child starts: the app-private HOME
// instead of an incidental DSH profile / workspace cwd.
// Source anchor: liustack/modsearch@5.10.11 dsh/index.js, function run().
import {existsSync, lstatSync, readFileSync, realpathSync, statSync, copyFileSync, chmodSync, writeFileSync, renameSync, unlinkSync, mkdirSync, cpSync} from 'node:fs'
import {resolve, join, relative, dirname} from 'node:path'
import {randomBytes} from 'node:crypto'
import {createRequire} from 'node:module'

const MARKER='DSH Android modsearch: stable app-private CLI cwd'
const ENV_MARKER='DSH Android modsearch: clean inherited NODE_OPTIONS for CLI'

const READ_MARKER='DSH Android modsearch: bounded original read_page local fallback'
// Inserted only into the ORIGINAL plugin. Do not bypass its URL/private-network
// restrictions: the local provider keeps the upstream SSRF checks and redirects.
const READ_HELPER = [
  '// '+READ_MARKER,
  'async function androidReadPageCli(cliArgs, signal) {',
  '  if (process.env.DSH_ANDROID_STANDALONE !== "1") return runCli(cliArgs, signal);',
  '  const urlIndex = cliArgs.indexOf("-u");',
  '  const queryIndex = cliArgs.indexOf("-q");',
  '  const hasFocus = queryIndex >= 0 && String(cliArgs[queryIndex + 1] || "").trim() !== "";',
  '  // Local-first for plain pages. Focused reads keep the cloud extraction first.',
  '  const localArgs = [...cliArgs.filter((_, i, all) => !["--timeout","--deadline"].includes(all[i-1]) && !["--timeout","--deadline"].includes(all[i]))];',
  '  localArgs.push("--engine", "local", "--timeout", "18000", "--deadline", "22000");',
  '  if (!hasFocus) {',
  '    try { return await runCli(localArgs, signal); }',
  '    catch (localError) {',
  '      if (signal?.aborted) throw localError;',
  '      // Some sites require cloud rendering; retain that fallback when direct fetch fails.',
  '      const cloudArgs = [...cliArgs.filter((_, i, all) => !["--timeout","--deadline"].includes(all[i-1]) && !["--timeout","--deadline"].includes(all[i]))];',
  '      cloudArgs.push("--timeout", "14000", "--deadline", "32000");',
  '      try { return await runCli(cloudArgs, signal); }',
  '      catch (cloudError) { throw new Error("read_page local and cloud engines failed. Local: " + String(localError?.message || localError).slice(0, 350) + "; Cloud: " + String(cloudError?.message || cloudError).slice(0, 350)); }',
  '    }',
  '  }',
  '  const remoteArgs = [...cliArgs.filter((_, i, all) => !["--timeout","--deadline"].includes(all[i-1]) && !["--timeout","--deadline"].includes(all[i]))];',
  '  remoteArgs.push("--timeout", "14000", "--deadline", "32000");',
  '  try { return await runCli(remoteArgs, signal); }',
  '  catch (primaryError) {',
  '    if (signal?.aborted) throw primaryError;',
  '    try {',
  '      const value = await runCli(localArgs, signal);',
  '      value.warnings = [...(Array.isArray(value.warnings) ? value.warnings : []),',
  '        "Android read_page: remote focused extraction unavailable; local HTML text returned without query-specific synthesis."];',
  '      return value;',
  '    } catch (localError) {',
  '      throw new Error("read_page remote and local engines failed. Remote: " + String(primaryError?.message || primaryError).slice(0, 350) + "; Local: " + String(localError?.message || localError).slice(0, 350));',
  '    }',
  '  }',
  '}',
].join('\n') + '\n\n'

const OLD='      signal,\n      env,\n    });'
const NEW='      signal,\n      env,\n      // '+MARKER+'\n      ...(process.env.DSH_ANDROID_STANDALONE === "1" ? { cwd: process.env.DSH_ANDROID_MODSEARCH_CWD || process.env.HOME || process.cwd() } : {}),\n    });'
function scoped(root, path) {
  const rel=relative(root,path)
  return rel==='' || (rel!=='..' && !rel.startsWith('../') && !rel.startsWith('..\\') && !rel.startsWith('/'))
}
function verifyManifest(dir){
  const manifest=JSON.parse(readFileSync(join(dir,'package.json'),'utf8'))
  return manifest.name==='@liustack/modsearch'
}
// Restore *only absent* published executable assets for a package that was
// installed from its source repository. Never replace manifests, user config,
// patch files, or already installed executables. The recovery bundle is staged
// from pinned npm releases in the APK by GitHub Actions (not downloaded at boot).
function recoverOriginalPublishedCli(home, name) {
  const recovery = process.env.DSH_ANDROID_MODSEARCH_RECOVERY
  if (process.env.DSH_ANDROID_STANDALONE !== '1' || !recovery) return {restored:[]}
  const location = resolve(home, '.dsh', 'profiles', name, 'node_modules', '@liustack', 'modsearch')
  if (!existsSync(location)) return {restored:[]}
  const installed = realpathSync(location)
  if (!scoped(home, installed)) return {restored:[], warning:'plugin-outside-app-home'}
  const manifest = JSON.parse(readFileSync(join(installed, 'package.json'), 'utf8'))
  if (manifest.name !== '@liustack/modsearch' || manifest.version !== '5.10.11') {
    return {restored:[], warning:'unsupported-published-version'}
  }
  const source = resolve(recovery)
  const published = join(source, '@liustack', 'modsearch')
  const publishedManifest = JSON.parse(readFileSync(join(published,'package.json'),'utf8'))
  if (publishedManifest.name !== manifest.name || publishedManifest.version !== manifest.version) {
    throw new Error('ModSearch recovery resource identity mismatch')
  }
  const restored = []
  const destinationDist = join(installed, 'dist')
  if (!existsSync(join(destinationDist, 'main.js'))) {
    // Existing non-directory nodes and symlinked destination paths must not
    // be followed. The original profile remains authoritative.
    if (existsSync(destinationDist) && (!lstatSync(destinationDist).isDirectory() || lstatSync(destinationDist).isSymbolicLink())) {
      throw new Error('ModSearch dist path is not a regular directory')
    }
    cpSync(join(published,'dist'), destinationDist, {
      recursive:true, force:false, errorOnExist:false, dereference:false
    })
    if (!existsSync(join(destinationDist,'main.js'))) throw new Error('ModSearch CLI recovery incomplete')
    restored.push('dist/main.js')
  }
  const originalRequire = createRequire(join(installed, 'dist', 'main.js'))
  for (const [dependency, expected] of [['commander','13.1.0'],['undici','7.29.0']]) {
    try { originalRequire.resolve(dependency); continue } catch {}
    const publishedDependency = join(source, dependency)
    const meta = JSON.parse(readFileSync(join(publishedDependency,'package.json'),'utf8'))
    if (meta.name !== dependency || meta.version !== expected) {
      throw new Error('ModSearch recovery dependency mismatch: '+dependency)
    }
    const target = join(installed, 'node_modules', dependency)
    if (existsSync(target) || lstatExists(target)) {
      // A damaged existing dependency is not safe to overwrite silently.
      throw new Error('Existing ModSearch dependency cannot be resolved: '+dependency)
    }
    mkdirSync(dirname(target), {recursive:true})
    cpSync(publishedDependency, target, {recursive:true,force:false,errorOnExist:true,dereference:false})
    originalRequire.resolve(dependency)
    restored.push('node_modules/'+dependency)
  }
  return {restored}
}
function lstatExists(file) { try { lstatSync(file); return true } catch { return false } }

function inspectProfile(home, name){
  const profile=resolve(home,'.dsh','profiles',name)
  const pkg=join(profile,'node_modules','@liustack','modsearch')
  if(!existsSync(pkg))return {profile:name,status:'absent'}
  const resolved=realpathSync(pkg)
  // Follow pnpm links inside the app-private profile tree; never modify an
  // arbitrary absolute link pointing elsewhere, even if its name matches.
  if(!scoped(home,resolved))return {profile:name,status:'external-package-path',packagePath:resolved}
  if(!verifyManifest(resolved))return {profile:name,status:'unexpected-package-identity'}
  // Node resolves bare imports relative to the installed CLI, not the DSH
  // Host. Detect an incomplete pnpm installation before tools start failing.
  const pkgManifest=JSON.parse(readFileSync(join(resolved,'package.json'),'utf8'))
  const localRequire=createRequire(join(resolved,'dist','main.js'))
  const unavailable=Object.keys(pkgManifest.dependencies||{}).filter(dep=>{
    try { localRequire.resolve(dep); return false } catch { return true }
  })
  if(unavailable.length)return {profile:name,status:'missing-npm-dependencies',packages:unavailable}
  const plugin=join(resolved,'dsh','index.js')
  const cli=join(resolved,'dist','main.js')
  if(!existsSync(plugin))return {profile:name,status:'plugin-entry-missing'}
  if(!existsSync(cli))return {profile:name,status:'cli-build-missing',advice:'Install the npm package, not the GitHub source URL'}
  const cliStat=statSync(cli)
  if(!cliStat.isFile())return {profile:name,status:'cli-not-a-file'}
  return {profile:name,status:'ready',plugin,cli,packagePath:resolved}
}
function patchPlugin(file) {
  const before=readFileSync(file,'utf8')
  if(!before.includes('function run(command, args, signal, env)') && !before.includes('function run(command,args,signal,env)'))
    return 'unknown-plugin-version'
  let next=before
  if(!next.includes(MARKER)){
    const count=next.split(OLD).length-1
    if(count!==1)return 'unexpected-spawn-shape-'+count
    next=next.replace(OLD,NEW)
  }
  if(!next.includes(ENV_MARKER)){
    const oldEnv='function childEnv() {'
    if(next.split(oldEnv).length!==2)return 'unexpected-env-function-shape'
    const compatEnv=[
      oldEnv,
      '  // '+ENV_MARKER,
      '  if (process.env.DSH_ANDROID_STANDALONE === "1") {',
      '    const cleaned = { ...process.env };',
      '    delete cleaned.NODE_OPTIONS;',
      '    return cleaned;',
      '  }'
    ].join('\n')
    next=next.replace(oldEnv,compatEnv)
  }
  if(!next.includes(READ_MARKER)){
    const start=next.indexOf('function registerReadPageTool(ctx) {')
    const end=next.indexOf('/** The CLI budget flags',start)
    if(start<0||end<0)return 'unexpected-read-page-tool-layout'
    const section=next.slice(start,end)
    const entry='const entry = await runCli(cliArgs, exec.signal);'
    if(section.split(entry).length!==2)return 'unexpected-read-page-call-layout'
    next=next.slice(0,start)+section.replace(entry,'const entry = await androidReadPageCli(cliArgs, exec.signal);')+next.slice(end)
    const helperAnchor='function childEnv() {'
    if(next.split(helperAnchor).length!==2)return 'unexpected-child-env-layout'
    next=next.replace(helperAnchor,READ_HELPER+helperAnchor)
  }
  if(next===before)return 'already-patched'
  const backup=file+'.dsh-pre-android-cwd.bak'
  if(!existsSync(backup))copyFileSync(file,backup)
  const mode=statSync(file).mode & 0o777
  const temp=file+'.dsh-tmp-'+randomBytes(6).toString('hex')
  try {
    writeFileSync(temp,next,{flag:'wx',mode})
    chmodSync(temp,mode)
    renameSync(temp,file)
  }finally{if(existsSync(temp))unlinkSync(temp)}
  return 'patched'
}
export function repairModsearch(home, write=false){
  const canonical=realpathSync(home)
  const results=[]
  for(const name of ['web','headless']){
    try{
      const recovery=write?recoverOriginalPublishedCli(canonical,name):{restored:[]}
      const item=inspectProfile(canonical,name)
      if(item.status!=='ready'){results.push({...item,...recovery});continue}
      results.push({profile:name,status:write?patchPlugin(item.plugin):'ready',cliPresent:true,...recovery})
    }catch(error){
      results.push({profile:name,status:'error',error:String(error?.code||error?.message||error).slice(0,240)})
    }
  }
  return {home:canonical,write,results}
}
if(process.argv[1] && resolve(process.argv[1])===new URL(import.meta.url).pathname){
  const flag=process.argv[2]
  const home=process.argv[3]
  if(!['--repair-home','--inspect-home'].includes(flag)||!home){
    console.error('Usage: node modsearch-android-compat.mjs --repair-home|--inspect-home <app-private-home>')
    process.exitCode=2
  }else{
    const report=repairModsearch(home,flag==='--repair-home')
    console.log(JSON.stringify(report))
    if(report.results.some(x=>x.status==='error'))process.exitCode=1
  }
}
