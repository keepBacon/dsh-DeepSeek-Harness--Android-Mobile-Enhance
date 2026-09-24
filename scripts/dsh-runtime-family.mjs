#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'

const fail = (message) => {
  console.error('[DSH family lock] ' + message)
  process.exit(2)
}

const readJson = (file) => {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) }
  catch (error) { fail('cannot read ' + file + ': ' + (error instanceof Error ? error.message : String(error))) }
}

function family(file, expected) {
  const value = readJson(file)
  if (value?.schema !== 2 || typeof value.version !== 'string' || !Array.isArray(value.packages)
    || value.vendorPackages === null || typeof value.vendorPackages !== 'object' || Array.isArray(value.vendorPackages)) {
    fail('invalid release-family lock')
  }
  if (expected !== undefined && value.version !== expected) {
    fail('family lock ' + value.version + ' does not match requested ' + expected)
  }
  value.packages = [...new Set(value.packages)]
  if (!value.packages.includes('@deepseek-ai/dsh') || value.packages.length < 200) {
    fail('incomplete DSH release-family lock')
  }
  for (const required of [
    '@deepseek-ai/cordis',
    '@deepseek-ai/cordis-plugin-hmr',
    '@deepseek-ai/cordis-plugin-loader',
    '@deepseek-ai/cordis-plugin-timer',
  ]) {
    if (typeof value.vendorPackages[required] !== 'string') fail('vendor lock missing ' + required)
  }
  return value
}

function lockName(key, entry) {
  if (typeof entry?.name === 'string') return entry.name
  const marker = 'node_modules/'
  const at = key.lastIndexOf(marker)
  if (at < 0) return undefined
  const parts = key.slice(at + marker.length).split('/')
  return parts[0]?.startsWith('@')
    ? (parts.length > 1 ? parts.slice(0, 2).join('/') : undefined)
    : (parts[0] || undefined)
}

function checkPackage(name, version, f, where, problems) {
  if (name === '@deepseek-ai/dsh' || name.startsWith('@deepseek-ai/dsh-')) {
    if (!f.packages.includes(name)) problems.push(where + ': unknown DSH-family package ' + name + '@' + String(version))
    else if (version !== f.version) problems.push(where + ': version skew ' + name + '@' + String(version) + '; expected ' + f.version)
    return 'dsh'
  }
  if (Object.hasOwn(f.vendorPackages, name)) {
    const expected = f.vendorPackages[name]
    if (version !== expected) problems.push(where + ': vendor version skew ' + name + '@' + String(version) + '; expected ' + expected)
    return 'vendor'
  }
  return undefined
}

function verifyLock(f, file) {
  const lock = readJson(file)
  if (lock?.packages === undefined) fail('unsupported npm lock: ' + file)
  const problems = []
  let dshCount = 0
  let rootSeen = false
  const vendorCounts = new Map()
  const cordisEntries = []
  for (const [key, entry] of Object.entries(lock.packages)) {
    const name = lockName(key, entry)
    if (typeof name !== 'string') continue
    const type = checkPackage(name, entry?.version, f, key || '<root>', problems)
    if (type === 'dsh') {
      dshCount++
      if (name === '@deepseek-ai/dsh') rootSeen = true
    } else if (type === 'vendor') {
      vendorCounts.set(name, (vendorCounts.get(name) ?? 0) + 1)
      if (name === '@deepseek-ai/cordis') cordisEntries.push(key)
    }
  }
  if (!rootSeen) problems.push('package-lock does not contain @deepseek-ai/dsh')
  for (const name of Object.keys(f.vendorPackages)) {
    if ((vendorCounts.get(name) ?? 0) < 1) problems.push('package-lock does not contain locked vendor package ' + name)
  }
  if (cordisEntries.length !== 1) {
    problems.push('package-lock resolves ' + cordisEntries.length + ' @deepseek-ai/cordis instances; expected exactly one: ' + cordisEntries.join(', '))
  }
  if (problems.length) fail('release/vendor-family skew in resolved npm lock:\n' + problems.slice(0, 50).join('\n'))
  console.log('[DSH] DSH release-family lock: OK (' + dshCount + ' package entries @ ' + f.version + ')')
  console.log('[DSH] Cordis vendor lock: OK (' + Object.keys(f.vendorPackages).length + ' exact vendor packages; singleton graph)')
}

function verifyInstalled(f, root) {
  const problems = []
  const stack = [path.resolve(root)]
  const visited = new Set()
  const cordisRealpaths = new Set()
  const vendorSeen = new Map()
  let dshCount = 0
  let rootSeen = false

  while (stack.length) {
    const dir = stack.pop()
    let real
    try { real = fs.realpathSync(dir) } catch { continue }
    if (visited.has(real)) continue
    visited.add(real)

    let entries
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { continue }

    const manifest = path.join(dir, 'package.json')
    if (fs.existsSync(manifest)) {
      try {
        const pkg = readJson(manifest)
        if (typeof pkg.name === 'string') {
          const type = checkPackage(pkg.name, pkg.version, f, manifest, problems)
          if (type === 'dsh') {
            dshCount++
            if (pkg.name === '@deepseek-ai/dsh') rootSeen = true
          } else if (type === 'vendor') {
            vendorSeen.set(pkg.name, (vendorSeen.get(pkg.name) ?? 0) + 1)
            if (pkg.name === '@deepseek-ai/cordis') cordisRealpaths.add(fs.realpathSync(dir))
          }
        }
      } catch {}
    }

    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || ['.cache', '.git', 'build'].includes(entry.name)) continue
      stack.push(path.join(dir, entry.name))
    }
  }

  if (!rootSeen) problems.push('installed tree does not contain @deepseek-ai/dsh')
  for (const name of Object.keys(f.vendorPackages)) {
    if ((vendorSeen.get(name) ?? 0) < 1) problems.push('installed tree does not contain locked vendor package ' + name)
  }
  if (cordisRealpaths.size !== 1) {
    problems.push('installed runtime contains ' + cordisRealpaths.size + ' physical @deepseek-ai/cordis instances; expected exactly one: ' + [...cordisRealpaths].join(', '))
  }
  if (problems.length) fail('release/vendor-family skew in installed runtime:\n' + problems.slice(0, 50).join('\n'))

  console.log('[DSH] Installed DSH release family: OK (' + dshCount + ' package entries @ ' + f.version + ')')
  console.log('[DSH] Cordis singleton: OK (' + [...cordisRealpaths][0] + ')')
}

const [mode, file, a, b] = process.argv.slice(2)
if (!mode || !file) fail('usage: dsh-runtime-family.mjs <manifest|verify-lock|verify-installed> <family-lock> ...')

if (mode === 'manifest') {
  if (!a || !b) fail('manifest needs <dsh-version> <pnpm-version>')
  const f = family(file, a)
  const dependencies = { '@deepseek-ai/dsh': f.version, pnpm: b, ...f.vendorPackages }
  const overrides = {}
  for (const name of f.packages) if (name !== '@deepseek-ai/dsh') overrides[name] = f.version
  for (const [name, version] of Object.entries(f.vendorPackages)) overrides[name] = version
  process.stdout.write(JSON.stringify({
    name: 'dsh-android-runtime-install',
    version: '0.0.0',
    private: true,
    dependencies,
    overrides,
  }, null, 2) + '\n')
} else if (mode === 'verify-lock') {
  if (!a) fail('verify-lock needs lock path')
  verifyLock(family(file, b), a)
} else if (mode === 'verify-installed') {
  if (!a) fail('verify-installed needs node_modules path')
  verifyInstalled(family(file, b), a)
} else {
  fail('unknown mode: ' + mode)
}
