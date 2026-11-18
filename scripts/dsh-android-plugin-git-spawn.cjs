'use strict'
// Android app-private executable paths are not reliably spawn(2)-able, even
// when the bundled Git ELF and its PATH wrapper exist. pnpm invokes Git via
// Node child_process.spawn/execFile, often bypassing shell command routing.
// Rewrite ONLY Git invocations to DSH's established system-shell ELF bridge.
// Never interpolate argv into shell text, rewrite unrelated commands, or
// expose credentials to a new process environment.
const childProcess = require('node:child_process')
const {syncBuiltinESMExports} = require('node:module')

const prefix = process.env.TERMUX__PREFIX || process.env.PREFIX || ''
const active = process.env.DSH_ANDROID_STANDALONE === '1' &&
  /^\/data\/(?:data|user\/\d+)\/[^/]+\/files\/usr\/?$/.test(prefix)
const root = prefix.replace(/\/+$/, '')
const binary = root + '/bin/git'
const bridge = root + '/libexec/dsh-mobile/android-exec.sh'

function matchGit(file) {
 return active && typeof file === 'string' &&
  (file === 'git' || file === binary ||
   file === root + '/libexec/dsh/wrappers/git')
}
function adaptGitCommand(file,argv=[]) {
 if (!matchGit(file)) return null
 return {command:'/system/bin/sh',args:[bridge,binary,...argv]}
}
if (active) {
 const nativeSpawn=childProcess.spawn
 childProcess.spawn=function(command,args,options) {
  const positional=Array.isArray(args)?args:[]
  const adapted=adaptGitCommand(command,positional)
  const opts=Array.isArray(args)?options:args
  if (adapted && !opts?.shell)
   return nativeSpawn.call(this,adapted.command,adapted.args,opts)
  return nativeSpawn.apply(this,arguments)
 }
 const nativeSpawnSync=childProcess.spawnSync
 childProcess.spawnSync=function(command,args,options) {
  const positional=Array.isArray(args)?args:[]
  const adapted=adaptGitCommand(command,positional)
  const opts=Array.isArray(args)?options:args
  if (adapted && !opts?.shell)
   return nativeSpawnSync.call(this,adapted.command,adapted.args,opts)
  return nativeSpawnSync.apply(this,arguments)
 }
 const nativeExecFile=childProcess.execFile
 childProcess.execFile=function(file,args,options,callback){
  const positional=Array.isArray(args)?args:[]
  const adapted=adaptGitCommand(file,positional)
  if (!adapted || (Array.isArray(args)?options:args)?.shell)
   return nativeExecFile.apply(this,arguments)
  if (Array.isArray(args))
   return nativeExecFile.call(this,adapted.command,adapted.args,options,callback)
  if (typeof args === 'function')
   return nativeExecFile.call(this,adapted.command,adapted.args,args)
  return nativeExecFile.call(this,adapted.command,adapted.args,args,options)
 }
 const nativeExecFileSync=childProcess.execFileSync
 childProcess.execFileSync=function(file,args,options) {
  const positional=Array.isArray(args)?args:[]
  const adapted=adaptGitCommand(file,positional)
  const opts=Array.isArray(args)?options:args
  if (adapted && !opts?.shell)
   return nativeExecFileSync.call(this,adapted.command,adapted.args,opts)
  return nativeExecFileSync.apply(this,arguments)
 }
 // Node ESM named imports cache native builtin exports. Refresh those bindings
 // so pnpm's import {spawn} from 'node:child_process' also gets the bridge.
 syncBuiltinESMExports()
}
module.exports={adaptGitCommand}
