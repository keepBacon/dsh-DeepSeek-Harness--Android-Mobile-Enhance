// Read-only preflight for DSH 0.2.2's plugin transaction.
// Called before pnpm changes node_modules, manifest, or lockfile. No disk
// mutations and no automatic compatibility exemptions.
export function androidUnchangedIncompatiblePlugins(
  beforeDependencies, installedBefore, rawSpecs, parseSpec, evaluate, exemptions,
) {
  const updating = new Set()
  for (const spec of rawSpecs) {
    try {
      const parsed = parseSpec(spec)
      if (parsed.kind === 'registry') updating.add(parsed.name)
    } catch {
      // Path/Git specs may not be inspected before installation. They must
      // not disable the protection for any other installed plugin.
    }
  }
  const stale = []
  for (const name of Object.keys(beforeDependencies)) {
    if (updating.has(name)) continue
    const installed = installedBefore.get(name)
    if (typeof installed !== 'string') continue
    let manifest
    try { manifest = JSON.parse(installed) } catch { continue }
    // Only DSH bundle plugins are gated, not ordinary transitive packages.
    if (!manifest || typeof manifest !== 'object' || !manifest.dsh?.bundle) continue
    let issue
    try { issue = evaluate(manifest, exemptions) } catch { continue }
    if (issue && !issue.exempted) stale.push({
      name: typeof manifest.name === 'string' ? manifest.name : name,
      version: typeof manifest.version === 'string' ? manifest.version : 'unknown',
      issue,
    })
  }
  return stale
}
