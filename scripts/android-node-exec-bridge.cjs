'use strict'
/**
 * Android Node child-process bridge.
 *
 * A Host launched via `linker64 /private/usr/bin/node` reports linker64 as
 * process.execPath. Libraries such as modsearch that spawn(process.execPath,
 * [cli]) then hand a JavaScript file to the dynamic linker as an ELF.
 *
 * Rewrite only Node self-spawns. All unrelated commands, arguments and env
 * stay untouched. Does not inspect or modify profiles, credentials or files.
 */
const path = require('node:path')
const cp = require('node:child_process')
const { syncBuiltinESMExports } = require('node:module')

const NODE_BIN = path.resolve(__dirname, '../../bin/node')
const LINKER64 = '/system/bin/linker64'
const ORIGIN = Symbol.for('dsh.android.node.exec.bridge')

function rewriteNodeInvocation(command, args, nodeBinary = NODE_BIN, linkerPath = LINKER64) {
  if (command !== nodeBinary) return { command, args }
  return { command: linkerPath, args: [nodeBinary, ...args] }
}

/** Return a restore handle for the Linux integration tests. */
function installNodeBridge({
  nodeBinary = NODE_BIN,
  linkerPath = LINKER64,
  allow = process.platform === 'android' && /(?:^|\/)linker64$/.test(process.execPath),
} = {}) {
  if (!allow || process[ORIGIN]) return { installed: false, restore() {} }
  const originals = {
    execPath: process.execPath,
    spawn: cp.spawn,
    spawnSync: cp.spawnSync,
    execFile: cp.execFile,
    execFileSync: cp.execFileSync,
    fork: cp.fork,
  }
  const transform = (method) => function bridgedNodeProcess(command, ...rest) {
    if (command !== nodeBinary && command !== originals.execPath) {
      return originals[method].call(this, command, ...rest)
    }
    const hasArgv = Array.isArray(rest[0])
    const argv = hasArgv ? rest[0] : []
    const tail = hasArgv ? rest.slice(1) : rest
    return originals[method].call(this, linkerPath, [nodeBinary, ...argv], ...tail)
  }
  for (const method of ['spawn', 'spawnSync', 'execFile', 'execFileSync']) {
    cp[method] = transform(method)
  }
  cp.fork = function bridgedFork(modulePath, args, options) {
    if (Array.isArray(args)) {
      const opts = options || {}
      return originals.fork.call(this, modulePath, args, {
        ...opts, execPath: linkerPath, execArgv: [nodeBinary, ...(opts.execArgv || process.execArgv)],
      })
    }
    const opts = args || {}
    return originals.fork.call(this, modulePath, {
      ...opts, execPath: linkerPath, execArgv: [nodeBinary, ...(opts.execArgv || process.execArgv)],
    })
  }
  process.execPath = nodeBinary
  process[ORIGIN] = true
  syncBuiltinESMExports()
  return {
    installed: true,
    restore() {
      for (const method of ['spawn', 'spawnSync', 'execFile', 'execFileSync', 'fork']) {
        cp[method] = originals[method]
      }
      process.execPath = originals.execPath
      delete process[ORIGIN]
      syncBuiltinESMExports()
    },
  }
}

module.exports = { installNodeBridge, rewriteNodeInvocation, NODE_BIN, LINKER64 }
installNodeBridge()
