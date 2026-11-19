'use strict'
// Android's app-private /files tree is noexec on modern devices. A PATH entry
// cannot make an ELF or #! script spawnable: Node child_process must use the
// trusted /system/bin/sh + Android linker bridge. This preload was originally
// Git-only and now handles explicit bundled native commands and private paths.
// Never concatenate argv into shell source, rewrite /system or /apex commands,
// or interfere with shell:true (whose expansion semantics must stay intact).
const childProcess = require('node:child_process')
const path = require('node:path')
const {syncBuiltinESMExports} = require('node:module')

const prefix = process.env.TERMUX__PREFIX || process.env.PREFIX || ''
const active = process.env.DSH_ANDROID_STANDALONE === '1' &&
  /^\/data\/(?:data|user\/\d+)\/[^/]+\/files\/usr\/?$/.test(prefix)
const root = prefix.replace(/\/+$/, '')
const privateFiles = path.dirname(root)
const binary = root + '/bin/git'
const bridge = root + '/libexec/dsh-mobile/android-exec.sh'

// Only these bare names are unambiguously supplied by the embedded Termux
// runtime. Do not hijack platform tools (sh, am, pm, logcat, getprop, etc.)
// or arbitrary binaries from a user's PATH.
const bundled = new Set([
  'node','npm','npx','pnpm','pnpx',
  'git','gh','ssh','python','python3','pip','pip3','bash','perl',
  'rg','fd','fzf','clang','clang++','cc','c++','gcc','g++',
  'make','cmake','ninja','ld.lld','pkg-config','qemu-x86_64',
  'lua-language-server','java','javac','curl','wget',
  'openssl','jq','yq','7zz','aapt2'
])

function inside(file, directory) {
  return file.startsWith(directory + '/')
}
function matchGit(file) {
  return active && typeof file === 'string' &&
    (file === 'git' || file === binary ||
     file === root + '/libexec/dsh/wrappers/git')
}
function adaptGitCommand(file, argv=[]) {
  if (!matchGit(file)) return null
  return {command:'/system/bin/sh',args:[bridge,binary,...argv]}
}
function targetFor(file, options) {
  if (!active || typeof file !== 'string' || !file) return null
  if (matchGit(file)) return binary
  if (file.startsWith('/system/') || file.startsWith('/apex/')) return null
  // A bare name is bridged only for known bundled commands. The linker
  // bridge deliberately strips PATH, so pass the absolute Termux entrypoint.
  if (!file.includes('/')) return bundled.has(file) ? root + '/bin/' + file : null
  if (path.isAbsolute(file)) {
    const resolved = path.normalize(file)
    return inside(resolved,privateFiles) ? resolved : null
  }
  // A workspace script under the app's private files directory is noexec too.
  // Resolve it against child cwd exactly as child_process would.
  const cwd = options && typeof options.cwd === 'string' ? options.cwd : process.cwd()
  const resolved = path.resolve(cwd,file)
  return inside(resolved,privateFiles) ? resolved : null
}
function adaptAndroidCommand(file, argv=[], options={}) {
  const target = targetFor(file,options)
  if (!target) return null
  return {command:'/system/bin/sh',args:[bridge,target,...argv]}
}

if (active) {
  const nativeSpawn = childProcess.spawn
  childProcess.spawn = function(command,args,options) {
    const argv = Array.isArray(args) ? args : []
    const opts = Array.isArray(args) ? options : args
    const adapted = !opts?.shell && adaptAndroidCommand(command,argv,opts)
    if (adapted) return nativeSpawn.call(this,adapted.command,adapted.args,opts)
    return nativeSpawn.apply(this,arguments)
  }
  const nativeSpawnSync = childProcess.spawnSync
  childProcess.spawnSync = function(command,args,options) {
    const argv = Array.isArray(args) ? args : []
    const opts = Array.isArray(args) ? options : args
    const adapted = !opts?.shell && adaptAndroidCommand(command,argv,opts)
    if (adapted) return nativeSpawnSync.call(this,adapted.command,adapted.args,opts)
    return nativeSpawnSync.apply(this,arguments)
  }
  const nativeExecFile = childProcess.execFile
  childProcess.execFile = function(file,args,options,callback) {
    const argv = Array.isArray(args) ? args : []
    const opts = Array.isArray(args) ? options : args
    const adapted = !opts?.shell && adaptAndroidCommand(file,argv,opts)
    if (!adapted) return nativeExecFile.apply(this,arguments)
    // Retain every documented overload, callback, cwd and environment.
    if (Array.isArray(args))
      return nativeExecFile.call(this,adapted.command,adapted.args,options,callback)
    if (typeof args === 'function')
      return nativeExecFile.call(this,adapted.command,adapted.args,args)
    return nativeExecFile.call(this,adapted.command,adapted.args,args,options)
  }
  const nativeExecFileSync = childProcess.execFileSync
  childProcess.execFileSync = function(file,args,options) {
    const argv = Array.isArray(args) ? args : []
    const opts = Array.isArray(args) ? options : args
    const adapted = !opts?.shell && adaptAndroidCommand(file,argv,opts)
    if (adapted) return nativeExecFileSync.call(this,adapted.command,adapted.args,opts)
    return nativeExecFileSync.apply(this,arguments)
  }
  // Node fork() uses its own internal spawn implementation; patching the
  // exported spawn() alone cannot fix fork(process.execPath) on Android.
  // Route its execPath through the system shell, prefixing the fork's
  // execArgv with [bridge, realNode]. IPC stdio stays owned by native fork().
  const nativeFork = childProcess.fork
  childProcess.fork = function(modulePath,args,options) {
    const hasArgs = Array.isArray(args)
    const opts = hasArgs ? options : args
    const nodePath = opts?.execPath || process.execPath
    const adapted = adaptAndroidCommand(nodePath,[],opts)
    if (!adapted || opts?.shell) return nativeFork.apply(this,arguments)
    const next = {
      ...opts,
      execPath: adapted.command,
      execArgv: [...adapted.args,...(opts?.execArgv || process.execArgv)]
    }
    return nativeFork.call(this,modulePath,hasArgs ? args : [],next)
  }
  // Refresh ESM named exports (spawn, fork, execFile, etc.) for pnpm/DSH.
  syncBuiltinESMExports()
}

module.exports = {adaptGitCommand,adaptAndroidCommand}
