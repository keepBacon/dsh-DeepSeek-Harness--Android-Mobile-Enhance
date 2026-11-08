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
const server = createServer((req, res) => {
  requests++
  if(req.url==='/not-found') {
    res.writeHead(404, {'content-type':'text/html; charset=utf-8'})
    res.end('<html>not found</html>')
    return
  }
  if(req.url==='/unavailable') {
    res.writeHead(503, {'content-type':'text/plain'})
    res.end('retry later')
    return
  }
  res.writeHead(200, {'content-type':'text/html; charset=utf-8'})
  if(req.url==='/concurrent') setTimeout(()=>res.end(html),30)
  else res.end(html)
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
  // A failed fetch is never served as successful cached content.
  for(const status of [404,503]){
    const endpoint=status===404?'/not-found':'/unavailable'
    const before=requests
    await assert.rejects(readWebPage({url:'http://127.0.0.1:'+server.address().port+endpoint}),new RegExp('HTTP_PAGE_ERROR.*'+status))
    await assert.rejects(readWebPage({url:'http://127.0.0.1:'+server.address().port+endpoint}),new RegExp('HTTP_PAGE_ERROR.*'+status))
    assert.equal(requests,before+2,'failed HTTP responses must not be cached')
  }
  // Concurrent reads share a single complete download, rather than racing
  // separate body/metadata renames in the same process.
  const concurrentUrl='http://127.0.0.1:'+server.address().port+'/concurrent'
  const before=requests
  const concurrent=await Promise.all(Array.from({length:8},()=>readWebPage({url:concurrentUrl,format:'html',maxChars:120})))
  assert.equal(requests,before+1,'concurrent read_page requests must fetch once')
  assert.ok(concurrent.every(p=>p.content===html.slice(0,120)))
  assert.equal((await readWebPage({url:concurrentUrl})).cached,true)
  console.log('[OK] paginated read_page: ' + windows + ' windows, 240k+ source chars, cached')
} finally {
  await new Promise(resolve => server.close(resolve))
  if (originalHome === undefined) delete process.env.HOME
  else process.env.HOME = originalHome
  await rm(home,{recursive:true,force:true})
}
