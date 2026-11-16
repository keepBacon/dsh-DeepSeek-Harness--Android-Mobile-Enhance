// P0: Single Android/desktop process entrypoint for the development stack.
// Project commands run without a shell; Android app-private scripts and ELF
// binaries enter the established system-linker bridge.
import { lstat, realpath } from 'node:fs/promises'
import { delimiter, isAbsolute, join, resolve, sep } from 'node:path'
import { androidToolLaunch } from './dsh-android-tool-spawn.mjs'
import { boundedSpawn } from './dsh-bounded-spawn.mjs'

const VALID_NAME = /^[A-Za-z0-9._+-]+$/
const MAX_ARGS = 128
function within(path, base) { return path === base || path.startsWith(base + sep) }
function clamp(n,d,min,max) { return Number.isFinite(n) ? Math.max(min,Math.min(max,n)) : d }
function prefixFor(env) { return env.TERMUX__PREFIX || env.PREFIX || '' }
function androidEnv(env) {
 const prefix = prefixFor(env)
 return !!prefix && (prefix.startsWith('/data/data/') || prefix.startsWith('/data/user/'))
}
function clean(name) {
 if (typeof name !== 'string' || !name.length || name.includes('\0')) throw Error('command must be nonempty string')
 return name
}
export async function resolveDevCommand(input,{cwd=process.cwd(),env=process.env}={}) {
 const command=clean(input)
 const prefix=prefixFor(env)
 if (!androidEnv(env) && env.DSH_ANDROID_STANDALONE !== '1') return {binary:command,kind:'desktop'}
 if (isAbsolute(command) || command.includes('/')) {
  const file=resolve(cwd,command)
  // Do not redirect paths to other apps; Android itself controls permissions.
  // Known scripts such as ./gradlew are run through their declared interpreter.
  return {binary:file,kind:'path'}
 }
 if (!VALID_NAME.test(command)) throw Error('invalid executable name')
 // Android's noexec app-data tree means that the ordinary PATH binary must
 // be resolved to an absolute Termux location before linker dispatch.
 if (prefix) {
  const candidate=join(prefix,'bin',command)
  try {
   const st=await lstat(candidate)
   if (st.isFile() || st.isSymbolicLink()) return {binary:candidate,kind:'termux'}
  } catch(e) { if(e.code!=='ENOENT') throw e }
 }
 // For direct absolute platform tools the caller should supply an absolute path.
 // A PATH search is still valid for executables on system executable mounts.
 return {binary:command,kind:'system'}
}
async function scriptInvocation(binary,args,cwd,env) {
 const prefix=prefixFor(env)
 // Gradle, pnpm, npm and project scripts are often shebang files. The Android
 // bridge recognizes common interpreters; preserve all original arguments.
 // Resolve shebang scripts by exact path, avoiding shell=true or eval.
 if (binary.endsWith('/gradlew') || binary === './gradlew') {
  const path=resolve(cwd,binary)
  try {
   const st=await lstat(path)
   if (st.isFile() || st.isSymbolicLink()) {
    if(androidEnv(env) || env.DSH_ANDROID_STANDALONE === '1') return {binary:join(prefix,'bin','sh'),args:[path,...args]}
    return {binary:path,args}
   }
  }catch(e){if(e.code!=='ENOENT')throw e}
 }
 return {binary,args}
}
export async function devLaunch(command,args=[],opts={}) {
 if (!Array.isArray(args) || args.length>MAX_ARGS || args.some(x=>typeof x!=='string'||x.includes('\0'))) throw Error('invalid argv')
 const cwd=resolve(opts.cwd||process.cwd()),env=opts.env||process.env
 const selected=await resolveDevCommand(command,{cwd,env})
 const choice=await scriptInvocation(selected.binary,args,cwd,env)
 const launch=androidToolLaunch(choice.binary,choice.args,env)
 return {...launch,requestedCommand:command,resolvedCommand:choice.binary,cwd,env}
}
export async function devRun(command,args=[],opts={}) {
 const launch=await devLaunch(command,args,opts)
 const result=await boundedSpawn(launch.command,launch.args,{
  cwd:launch.cwd,env:launch.env,timeoutMs:clamp(opts.timeoutMs,30000,100,3600000),
  maxOutputBytes:clamp(opts.maxOutputBytes,131072,1024,1048576),
  signal:opts.signal,onData:opts.onData,killTree:true,
 })
 return {...result,requestedCommand:command,resolvedCommand:launch.resolvedCommand,bridged:launch.bridged,
  command:launch.command,args:launch.args,ok:result.exitCode===0&&!result.timedOut&&!result.cancelled}
}
