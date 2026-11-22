#!/usr/bin/env node
/**
 * DSH Android plugin runtime artifact parity gate (0.2.2-rc.5).
 *
 * Checks the ACTUALLY INSTALLED package family, not README promises. The
 * Android APK must ship the upstream Host/Cordis/Web client/RPC/MCP parts as
 * one resolved family. This is an artifact-integrity check, not a substitute
 * for Android app-UID execution, plugin authentication or lifecycle E2E.
 */
import assert from 'node:assert/strict'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'

const PACKAGES = Object.freeze([
  '@deepseek-ai/dsh',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-app-boot',
  '@deepseek-ai/dsh-client-modules',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-plugin-manager',
  '@deepseek-ai/dsh-plugin-manager',
  '@deepseek-ai/dsh-api-remotes',
  '@deepseek-ai/dsh-api-remote-access',
  '@deepseek-ai/dsh-mcp-client',
  '@deepseek-ai/dsh-mcp-manager',
  '@deepseek-ai/dsh-ptc-runtime-node',
])
const CLIENTS = new Set([
  '@deepseek-ai/dsh-client-modules',
  '@deepseek-ai/dsh-client-ui-plugin-manager',
])
function executableExports(entry) {
  if (typeof entry === 'string') return [entry]
  if (!entry || typeof entry !== 'object') return []
  // Type declarations do not load in WebView or Host. Conditions are checked
  // as a set so the gate does not assume one particular bundler export order.
  return Object.entries(entry).flatMap(([key, value]) =>
    key === 'types' ? [] : executableExports(value))
}
function exportedFiles(packageDir, entry) {
  const root = resolve(packageDir)
  return executableExports(entry).filter(file => {
    if (!file.startsWith('./')) return false
    const path = resolve(root, file)
    return path.startsWith(root + sep) && existsSync(path) && statSync(path).isFile()
  })
}
export function validate(modulesDir) {
  const missing = []
  const inspected = []
  for (const name of PACKAGES) {
    const dir = join(modulesDir, name)
    const filename = join(dir, 'package.json')
    if (!existsSync(filename)) { missing.push(name + ': package.json missing'); continue }
    let pkg
    try { pkg = JSON.parse(readFileSync(filename, 'utf8')) }
    catch (error) { missing.push(name + ': malformed package.json (' + String(error) + ')'); continue }
    if (pkg.name !== name) missing.push(name + ': manifest identity mismatch')
    if (name !== '@deepseek-ai/cordis' && pkg.version !== '0.2.2-rc.5') {
      missing.push(name + ': version ' + String(pkg.version) + ' differs from DSH 0.2.2-rc.5')
    }
    const main = pkg.exports?.['.'] ?? pkg.main
    if (main === undefined || exportedFiles(dir, main).length === 0) {
      missing.push(name + ': runtime entry missing or not packaged')
    }
    if (CLIENTS.has(name) &&
      exportedFiles(dir, pkg.exports?.['./client']).length === 0) {
      missing.push(name + ': ./client browser entry missing')
    }
    inspected.push({ name, version: pkg.version })
  }
  if (missing.length) {
    throw new Error('Android plugin runtime family incomplete:\n' + missing.join('\n'))
  }
  return inspected
}
function selfTest() {
  assert.deepEqual(executableExports({
    types: './lib/index.d.ts', import: './lib/index.js', default: './lib/main.js',
  }), ['./lib/index.js', './lib/main.js'])
  assert.deepEqual(executableExports({ types: './lib/index.d.ts' }), [])
  assert.deepEqual(executableExports(null), [])
  assert.deepEqual(executableExports('./index.js'), ['./index.js'])
  console.log('[DSH] Plugin runtime artifact resolver self-test: OK')
}
if (process.argv[2] === '--self-test') selfTest()
else if (process.argv[2]) {
  const results = validate(resolve(process.argv[2]))
  console.log('[DSH] Plugin runtime family entry/exports integrity: OK (' + results.length + ' packages)')
} else {
  console.error('usage: node validate-android-plugin-runtime-parity.mjs --self-test | <node_modules-dir>')
  process.exitCode = 2
}
