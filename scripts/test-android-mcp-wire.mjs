#!/usr/bin/env node
// DSH host-side MCP wire regression. Runs against bundled servers, not plugins.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const [prefix] = process.argv.slice(2);
if (!prefix) throw new Error('Usage: node scripts/test-android-mcp-wire.mjs <stage/usr>');
function open(command,args,cwd,env) {
  const child=spawn(command,args,{cwd,env,stdio:['pipe','pipe','pipe']});
  let seq=0,buffer='',errors='',closed=false;
  const pending=new Map();
  function rejectAll(reason){closed=true;for(const [id,p] of pending){clearTimeout(p.timer);p.reject(reason)}pending.clear()}
  child.stderr.on('data',c=>{errors=(errors+c.toString()).slice(-4096)});
  child.on('error',rejectAll);
  child.on('close',(code,signal)=>rejectAll(new Error('MCP child closed: '+(code??signal)+' '+errors)));
  child.stdout.on('data',part=>{
    buffer+=part.toString();
    if(buffer.length>8*1024*1024){rejectAll(new Error('MCP frame too large'));child.kill();return}
    let offset;
    while((offset=buffer.indexOf('\n'))>=0) {
      const frame=buffer.slice(0,offset).trim();buffer=buffer.slice(offset+1);
      if(!frame)continue;
      let message;
      try{message=JSON.parse(frame)}catch{rejectAll(new Error('Invalid MCP stdout: '+frame.slice(0,150)));child.kill();return}
      const p=pending.get(message.id);if(!p)continue;
      pending.delete(message.id);clearTimeout(p.timer);
      if(message.error)p.reject(new Error(JSON.stringify(message.error)));else p.resolve(message.result);
    }
  });
  const send=v=>{if(closed)throw new Error('MCP child closed: '+errors);child.stdin.write(JSON.stringify(v)+'\n')};
  return {
    request(method,params){
      const id=++seq;
      return new Promise((resolve,reject)=>{
        const timer=setTimeout(()=>{pending.delete(id);reject(new Error(method+' timed out: '+errors));child.kill()},12000);
        pending.set(id,{resolve,reject,timer});
        try{send({jsonrpc:'2.0',id,method,params})}catch(e){pending.delete(id);clearTimeout(timer);reject(e)}
      })
    },
    notify(method){send({jsonrpc:'2.0',method,params:{}})},
    async close(){
      if(!closed)child.kill('SIGTERM');
      if(child.exitCode===null&&child.signalCode===null)await new Promise(done=>{const timer=setTimeout(()=>{child.kill('SIGKILL');done()},1500);child.once('close',()=>{clearTimeout(timer);done()})})
    }
  };
}
function payload(result){
  assert.notEqual(result.isError,true,JSON.stringify(result.content));
  return result.structuredContent??JSON.parse(result.content.find(x=>x.type==='text').text);
}
async function test(kind,dir){
  const node=join(prefix,'bin/node');
  const script=join(prefix,'libexec/dsh-mobile',kind==='mobile'?'toolbox-mcp.mjs':'basic-toolbox-mcp.mjs');
  const service=open(node,[script],dir,{...process.env,TERMUX__PREFIX:prefix,PREFIX:prefix,HOME:dir,TMPDIR:dir});
  try{
    const init=await service.request('initialize',{protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'dsh-wire-test',version:'1.0.0'}});
    assert.ok(init.serverInfo?.name);
    service.notify('notifications/initialized');
    const listing=await service.request('tools/list',{});
    const names=listing.tools.map(x=>x.name);
    assert.equal(names.length,new Set(names).size,'duplicate tool names');
    assert.ok(names.length>=(kind==='mobile'?60:50),'tool registry incomplete: '+names.length);
    async function call(name,args){
      assert.ok(names.includes(name),'missing tool '+name);
      return payload(await service.request('tools/call',{name,arguments:args}))
    }
    const unknown=await service.request('tools/call',{name:'__dsh_missing_wire_tool__',arguments:{}});
    assert.equal(unknown.isError,true,'unknown tool must return isError');
    if(kind==='mobile'){
      const file=join(dir,'mobile-write.txt'),text='中文🚀\n{"nested":[1,true,null],"escaped":"\\u2603"}\n';
      await call('fs_write',{path:file,content:text});
      assert.equal(await readFile(file,'utf8'),text);
      assert.equal((await call('fs_read',{path:file})).content,text);
      // The target GDB executable can be absent on trimmed Android builds.
      // Failure must be a normal MCP tool result, never a connection drop.
      const debug=await service.request('tools/call',{name:'debug_session_start',arguments:{}});
      if(debug.isError){
        assert.match(JSON.stringify(debug),/GDB unavailable|gdb|debug/i);
      }else{
        const sid=debug.structuredContent?.sessionId;
        assert.ok(sid,'successful debug start must return a sessionId');
        await service.request('tools/call',{name:'debug_session_close',arguments:{sessionId:sid}});
      }
      const afterDebug=await service.request('tools/list',{});
      assert.equal(afterDebug.tools.length,names.length,'GDB probe must not disconnect MCP');
      await call('fs_patch',{path:file,oldText:'中文',newText:'修复'});
      assert.equal(await readFile(file,'utf8'),text.replace('中文','修复'));
    }else{
      const src=join(dir,'src.txt'),dst=join(dir,'dst.txt'),moved=join(dir,'moved.txt');
      const text='中文🚀\n{"nested":[1,true,null]}\n';
      await writeFile(src,text);
      assert.equal((await call('file_hash',{path:src,algorithm:'sha256'})).digest,
        createHash('sha256').update(text).digest('hex'));
      const dbPath=join(dir,'fixture.db');
      const db=new DatabaseSync(dbPath);
      db.exec("CREATE TABLE sample (id INTEGER PRIMARY KEY, label TEXT); INSERT INTO sample (label) VALUES ('ok')");
      db.close();
      assert.equal((await call('sqlite_query',{path:dbPath,sql:'SELECT label FROM sample'})).rows[0].label,'ok');
      assert.ok((await call('sqlite_schema',{path:dbPath})).objects.some(x=>x.name==='sample'));
      const denied=await service.request('tools/call',{name:'sqlite_query',arguments:{
        path:dbPath,sql:"DELETE FROM sample"
      }});
      assert.equal(denied.isError,true,'sqlite_query must reject writes');
      await call('file_copy',{source:src,destination:dst});
      assert.equal(await readFile(dst,'utf8'),text);
      await call('file_move',{source:dst,destination:moved});
      assert.equal(await readFile(moved,'utf8'),text);
      assert.equal((await call('file_delete',{path:moved})).deleted,true);
      assert.equal((await call('base_convert',{data:text,to:'base64'})).value,Buffer.from(text).toString('base64'));
    }
    console.log('[DSH] '+kind+' MCP wire passed, tools='+names.length);
  }finally{await service.close()}
}
const dir=await mkdtemp(join(tmpdir(),'dsh-mcp-wire-'));
try{for(const kind of ['mobile','basic'])await test(kind,dir)}
finally{await rm(dir,{recursive:true,force:true})}
