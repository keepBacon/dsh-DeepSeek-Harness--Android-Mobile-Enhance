/**
 * Fail-closed transformation of the two installed DSH Skill provider entrypoints.
 * Do not edit user SKILL.md or profile manifests. An ordinary runtime run is a
 * byte-for-byte behavioral no-op (guard only reads an environment variable).
 */
export const SAFE_SKILL_MARKER = 'DSH Android safe mode: suppress Skill activation'
export function guardSkillApply(source) {
  if (source.includes(SAFE_SKILL_MARKER)) return { status:'already', content:source }
  const pattern = /\bfunction apply\s*\([^)]*\)\s*\{/g
  const hits = [...source.matchAll(pattern)]
  if (hits.length !== 1) throw new Error('safe-mode Skill activation anchor missing or ambiguous: ' + hits.length)
  return {
    status: 'patched',
    content: source.replace(pattern, match =>
      match + '\n  if (process.env.DSH_ANDROID_SAFE_MODE === "1") return; /* ' + SAFE_SKILL_MARKER + ' */'
    ),
  }
}
