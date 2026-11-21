#!/usr/bin/env node
// Static regression for Android-side SAF/share-sheet file imports. Kotlin
// compile is the executable contract; real shared-storage FUSE needs a device.
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
const source=readFileSync(new URL('../app/src/main/java/com/dshmobile/shell/MainActivity.kt',import.meta.url),'utf8')
const start=source.indexOf('  private fun publishWorkspaceImport(')
const end=source.indexOf('  private fun notifyWorkspaceFilesImported(',start)
assert.ok(start>=0&&end>start,'workspace importer missing')
const block=source.slice(start,end)
assert.ok(block.includes('java.nio.file.Files.createLink(candidate.toPath(), temp.toPath())'))
assert.ok(block.includes('java.nio.file.FileAlreadyExistsException'))
assert.ok(block.includes('linkError is java.nio.file.AccessDeniedException'))
assert.ok(block.includes('if (!unsupportedLink) throw linkError'),
  'unrelated filesystem I/O failures must not trigger the fallback')
assert.ok(block.includes('java.nio.file.StandardOpenOption.CREATE_NEW'))
assert.ok(block.includes('java.nio.channels.FileChannel.open(candidate.toPath()'),
  'reserve/open must be a single exclusive operation')
assert.ok(block.includes('channel.force(true)'),'copied content must be synced')
assert.ok(!block.includes('candidate.createNewFile() continue'),
  'reserve + reopen race must not be the active fallback')
assert.ok(block.includes('if (created) candidate.delete()'),
  'failed copies may only remove this operation’s reserved candidate')
console.log('[DSH] Android SAF file import exclusive create / hard-link fallback source contract OK')
