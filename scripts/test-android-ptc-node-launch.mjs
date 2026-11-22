#!/usr/bin/env node
// Android PTC worker bootstrap regression. This fixture exercises the same
// source seams as the published 0.2.2 bundle. CI also patches actual packages.
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = new URL('../', import.meta.url)
const patcher = fileURLToPath(new URL('./android-runtime-patch.mjs', import.meta.url))
const tmp = mkdtempSync(join(tmpdir(), 'dsh-android-ptc-'))
const moduleDir = join(tmp, 'usr/lib/node_modules/@deepseek-ai/dsh-ptc-runtime-node')
const entry = join(moduleDir, 'lib/index.js')
const fixture = [
  'export function resolveLaunch(config) {',
  '  const launch = config ?? { kind: "pkg" in process ? "embedded" : "node-script", executable: process.execPath }',
  '  return launch',
  '}',
  'export class ProgramWorker {',
  '  constructor(ctx) { this.ctx = ctx; this.confined = undefined }',
  '  async start() {',
  '    const argv = ["/invalid"]',
  '    const cwd = "/tmp"',
  '    const env = Object.fromEntries(Object.keys(process.env)',
  "      .filter(key => !new Set(['PATH','TMP']).has(key.toUpperCase()))",
  '      .map(key => [key, undefined]))',
  '    const handle = this.ctx.subprocess.spawn({ argv: this.confined?.argv ?? argv, cwd, env, stdio: {}, graceMs: 10 })',
  '    return handle',
  '  }',
  '}',
].join('\n') + '\n'

const patch = () => spawnSync(process.execPath, [patcher, join(tmp, 'usr')], {
  encoding: 'utf8',
  env: { ...process.env, DSH_TARGET_VERSION: '0.2.2-rc.5',
    DSH_COMPAT_ONLY_PACKAGES: '@deepseek-ai/dsh-ptc-runtime-node' },
})
try {
  mkdirSync(join(moduleDir, 'lib'), { recursive: true })
  writeFileSync(join(moduleDir, 'package.json'),
    JSON.stringify({ name: '@deepseek-ai/dsh-ptc-runtime-node', type: 'module' }))
  writeFileSync(entry, fixture)
  const first = patch()
  assert.equal(first.status, 0, first.stderr || first.stdout)
  const code = readFileSync(entry, 'utf8')
  assert.match(code, /DSH Android compat: PTC embedded Node launch and startup env/)
  assert.match(code, /env\.TERMUX__PREFIX = prefix/)
  assert.match(code, /env\.LD_LIBRARY_PATH = process\.env\.LD_LIBRARY_PATH/)
  assert.match(code, /env\.TMPDIR = process\.env\.TMPDIR/)
  const keys = ['DSH_ANDROID_STANDALONE', 'TERMUX__PREFIX', 'PREFIX',
    'LD_LIBRARY_PATH', 'TMPDIR', 'TEST_SECRET_TOKEN']
  const saved = Object.fromEntries(keys.map(k => [k, process.env[k]]))
  try {
    process.env.DSH_ANDROID_STANDALONE = '1'
    process.env.TERMUX__PREFIX = '/data/data/com.dshmobile.shell/files/usr'
    process.env.PREFIX = process.env.TERMUX__PREFIX
    process.env.LD_LIBRARY_PATH = process.env.PREFIX + '/lib'
    process.env.TMPDIR = '/data/data/com.dshmobile.shell/files/home/tmp'
    process.env.TEST_SECRET_TOKEN = 'never-forward'
    const { resolveLaunch, ProgramWorker } = await import(pathToFileURL(entry).href)
    assert.equal(resolveLaunch().executable, process.env.PREFIX + '/bin/node')
    assert.equal(resolveLaunch({ kind:'node-script', executable:'/custom/node' }).executable,
      '/custom/node', 'explicit launch must not be overwritten')
    let observed
    const worker = new ProgramWorker({ subprocess: { spawn: spec => (observed = spec) } })
    await worker.start()
    assert.equal(observed.env.TERMUX__PREFIX, process.env.PREFIX)
    assert.equal(observed.env.PREFIX, process.env.PREFIX)
    assert.equal(observed.env.LD_LIBRARY_PATH, process.env.LD_LIBRARY_PATH)
    assert.equal(observed.env.TMPDIR, process.env.TMPDIR)
    assert.equal(observed.env.TEST_SECRET_TOKEN, undefined, 'credentials must remain scrubbed')
    delete process.env.DSH_ANDROID_STANDALONE
    assert.equal(resolveLaunch().executable, process.execPath, 'desktop must remain unchanged')
    await worker.start()
    assert.equal(observed.env.TERMUX__PREFIX, undefined, 'desktop env must not be changed')
    process.env.DSH_ANDROID_STANDALONE = '1'
    delete process.env.TERMUX__PREFIX
    delete process.env.PREFIX
    assert.throws(() => resolveLaunch(), /embedded Node prefix unavailable/)
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
  const again = patch()
  assert.equal(again.status, 0, again.stderr || again.stdout)
  assert.equal(readFileSync(entry, 'utf8'), code, 'patch must be idempotent')
  writeFileSync(entry, fixture.replace('executable: process.execPath',
    'executable: "/other/launcher"'))
  const drift = patch()
  assert.notEqual(drift.status, 0, 'unknown upstream seam must fail build')
  assert.match(drift.stderr, /resolveLaunch default executable seam changed/)
  assert.ok(!existsSync(new URL('../app/src/main/assets/dsh-tool-call-monitor.js', root)),
    'removed UI monitor must not be packaged')
  const activity = readFileSync(new URL('../app/src/main/java/com/dshmobile/shell/MainActivity.kt', root), 'utf8')
  assert.doesNotMatch(activity, /installPassiveToolCallMonitor|dsh-tool-call-monitor/)
  const bridge = readFileSync(new URL('../app/src/main/java/com/dshmobile/shell/AndroidBridge.kt', root), 'utf8')
  assert.doesNotMatch(bridge, /recordToolObservation/)
  console.log('[DSH] Android PTC Node launch, worker startup env and removed tool UI: OK')
} finally {
  rmSync(tmp, { recursive: true, force: true })
}
