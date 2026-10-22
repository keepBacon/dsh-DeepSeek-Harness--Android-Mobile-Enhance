import assert from 'node:assert/strict'
import vm from 'node:vm'
import { guardSkillApply, SAFE_SKILL_MARKER } from './safe-mode-skill-patch.mjs'

const source = 'let calls=0; function apply(value) { calls++; return value+1; }'
const patched = guardSkillApply(source)
assert.equal(patched.status, 'patched')
assert.equal(guardSkillApply(patched.content).status, 'already')
assert.equal(guardSkillApply(patched.content).content, patched.content)
assert.ok(patched.content.includes(SAFE_SKILL_MARKER))
for (const [flag, expected] of [[undefined, [2,1]], ['0',[2,1]], ['1',[undefined,0]]]) {
  const context = { process: { env: { DSH_ANDROID_SAFE_MODE: flag } } }
  const result = vm.runInNewContext(patched.content + '; [apply(1),calls]', context)
  assert.deepEqual(Array.from(result), expected)
}
assert.throws(() => guardSkillApply('export function activate() {}'), /anchor/)
assert.throws(() => guardSkillApply('function apply() {} function apply(x) {}'), /ambiguous/)
console.log('safe-mode Skill provider guard: syntax, idempotence, on/off isolation PASS')
