import { createServer } from 'node:http'
import { strict as assert } from 'node:assert'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readWebPage, readPageTool } from './dsh-web-page-reader.mjs'

const originalHome = process.env.HOME
const home = await mkdtemp(join(tmpdir(), 'dsh-read-page-'))
process.env.HOME = home
const payload = 'abc123'.repeat(40000)
const html = '<html><body><h1>Test &amp; title</h1><p>' + payload + '</p></body></html>'
let requests = 0
const server = createServer((_req, res) => {
  requests++
  res.writeHead(200, {'content-type':'text/html; charset=utf-8'})
  res.end(html)
})
try {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const url = 'http://127.0.0.1:' + server.address().port + '/'
  assert.equal(readPageTool.name, 'read_page')
  let pos = 0, complete = '', windows = 0
  while (true) {
    const page = await readWebPage({url, format:'html',offsetChars:pos,maxChars:17777})
    assert.equal(page.completeSource, true)
    assert.equal(page.totalChars, html.length)
    assert.equal(page.offsetChars, pos)
    complete += page.content
    pos = page.nextOffsetChars
    windows++
    if (!page.hasMore) break
  }
  assert.equal(complete, html)
  assert.ok(windows > 10, 'must paginate rather than truncate')
  assert.equal(requests, 1, 'subsequent windows must use cached bytes')
  const parsed = await readWebPage({url,maxChars:120})
  assert.ok(parsed.content.includes('Test & title'))
  assert.equal(parsed.cached, true)
  await readWebPage({url,refresh:true,maxChars:100})
  assert.equal(requests, 2)
  console.log('[OK] paginated read_page: ' + windows + ' windows, 240k+ source chars, cached')
} finally {
  await new Promise(resolve => server.close(resolve))
  if (originalHome === undefined) delete process.env.HOME
  else process.env.HOME = originalHome
  await rm(home,{recursive:true,force:true})
}
