#!/usr/bin/env node
// Android export contracts: do not expose partial downloads or race reopening
// a reserved destination pathname. Device FUSE validation remains separate.
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
const activity=readFileSync(new URL('../app/src/main/java/com/dshmobile/shell/MainActivity.kt',import.meta.url),'utf8')
const start=activity.indexOf('  private fun saveToWorkspaceStreamed(')
const end=activity.indexOf('  private fun queryDisplayName(',start)
assert.ok(start>=0&&end>start,'export implementation missing')
const section=activity.slice(start,end)
assert.match(section,/\.dsh-export-\$\{java\.util\.UUID\.randomUUID\(\)\}\.tmp/,
 'partial downloads must use a hidden random staging name')
assert.match(section,/FileChannel\.open\(temp\.toPath\(\)/,
 'stage must be opened as an exclusive handle')
assert.match(section,/StandardOpenOption\.CREATE_NEW/,
 'a competing stage must never be overwritten')
assert.match(section,/copyWithLimit\(input, output, MAX_DOWNLOAD_BYTES/,
 'download limit applies before publication')
assert.match(section,/channel\.force\(true\)/,
 'download content should be synced before publication')
assert.match(section,/return publishWorkspaceImport\(temp, dir, filename\)/,
 'publish completed stage through exclusive no-replace helper')
assert.match(section,/finally \{[\s\S]*?temp\.delete\(\)/,
 'failed download must remove stage')
assert.doesNotMatch(section,/reserveUniqueFile\(|target\.outputStream\(/,
 'do not reserve a visible name then reopen it by pathname')
const publish=activity.slice(activity.indexOf('  private fun publishWorkspaceImport('),
 activity.indexOf('  private fun notifyWorkspaceFilesImported('))
assert.match(publish,/Files\.createLink\(candidate\.toPath\(\), temp\.toPath\(\)\)/)
assert.match(publish,/StandardOpenOption\.CREATE_NEW/,
 'Android FUSE fallback must never clobber an existing file')
assert.match(publish,/channel\.force\(true\)/,
 'Android FUSE fallback must sync copied content')
console.log('[DSH] Android workspace export stage/write/sync/exclusive publish contract OK')
