#!/usr/bin/env node
import assert from 'node:assert/strict'
import {mobileToolCall,mobileDispatchToolCall} from './dsh-mobile-toolbox-mcp.mjs'
const body='first line\r\n\r\nsecond line\n\nthird line'
const parsed=await mobileToolCall('protocol_parse_http',{message:'POST /mcp HTTP/1.1\r\nContent-Type: text/plain\r\n\r\n'+body})
assert.equal(parsed.bodyBytes,Buffer.byteLength(body))
assert.equal(parsed.bodyPreview,body)
assert.equal(parsed.headers['content-type'][0],'text/plain')
const empty=await mobileToolCall('protocol_parse_http',{message:'HTTP/1.1 204 No Content\r\n\r\n'})
assert.equal(empty.bodyBytes,0)
const bad=await mobileDispatchToolCall({name:'protocol_parse_url',arguments:{url:'not a url'}})
assert.equal(bad.isError,true)
assert.ok(typeof bad.structuredContent?.error==='string')
const unknown=await mobileDispatchToolCall({name:'__nonexistent__',arguments:{}})
assert.equal(unknown.isError,true)
const malformed=await mobileDispatchToolCall({name:'protocol_parse_url',arguments:[]})
assert.equal(malformed.isError,true)
console.log('[DSH] mobile MCP protocol dispatch regression: OK')
