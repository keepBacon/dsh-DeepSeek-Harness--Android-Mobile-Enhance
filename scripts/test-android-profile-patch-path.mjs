#!/usr/bin/env node
// Guard against editing a public migration copy while the DSH launcher loads
// the distinct private profile patch. Read-only source contract.
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
const engine=readFileSync(new URL('../app/src/main/java/com/dshmobile/shell/EngineManager.kt',import.meta.url),'utf8')
const find=(a,b)=>{const i=engine.indexOf(a),j=engine.indexOf(b,i+a.length);assert.ok(i>=0&&j>i,a);return engine.slice(i,j)}
const select=find('  fun profilePatchFile(','  /** Read-only triage:')
assert.match(select,/File\(profileDir\(profile\), "cordis\.patch\.yml"\)/)
assert.match(select,/Files\.isSymbolicLink\(privateFile\.toPath\(\)\)/)
assert.match(select,/symlinkPointsTo\(privateFile, publicFile\)/)
assert.match(select,/if \(privateFile\.isFile\) \{/)
assert.ok(select.indexOf('if (privateFile.isFile)')<select.indexOf('if (publicFile.isFile)'), 'active private patch must have precedence over orphaned public patch')
assert.ok(!select.includes('if (publicFile.exists()) return publicFile'),'never prefer public copy over real engine source')
assert.match(select,/if \(publicFile\.isFile\)\s+Log\.w/)
assert.ok(select.trimEnd().endsWith('return privateFile\n  }'))
const diag=find('  fun profilePatchPathDiagnostics(','  fun readProfilePatch(')
assert.match(diag,/sizeDivergence=/)
assert.match(diag,/privateIsSymlink=/)
assert.match(diag,/linksToPublic=/)
const inventory=find('  private fun normalProfileLayerDiagnostics()','  /** Last useful engine diagnostics')
assert.match(inventory,/profilePatchPathDiagnostics\("web"\)/)
const save=find('  fun saveProfilePatch(','  /** Parse the composed profile')
assert.match(save,/val file = profilePatchFile\(profile\)/)
assert.match(save,/if \(previous == null\) file\.delete\(\) else writeTextAtomic\(file, previous\)/)
const reset=find('  fun backupAndResetProfilePatch(','  private fun writeTextAtomic(')
assert.match(reset,/val file = profilePatchFile\(profile\)/)
console.log('[DSH] Web settings edit active loader patch and preserve conflicting public copy')
