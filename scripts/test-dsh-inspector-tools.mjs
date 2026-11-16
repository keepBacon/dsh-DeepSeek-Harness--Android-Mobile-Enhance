#!/usr/bin/env node
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,readdir,rm,symlink,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const root=await mkdtemp(join(tmpdir(),'dsh-inspector-'));
process.env.PREFIX=join(root,'usr');
const {inspectorTools,inspectorCall}=await import('./dsh-inspector-tools.mjs');
try {
 const project=join(root,'project');await mkdir(project);
 await writeFile(join(project,'a.js'),"import './b.js';\nexport const a=1;\n");
 await writeFile(join(project,'b.js'),"import './a.js';\nexport const b=1;\n");
 await writeFile(join(project,'missing.ts'),"import './nope.js';\n");
 await writeFile(join(project,'package.json'),'{}');
 await mkdir(join(project,'node_modules'));await writeFile(join(project,'node_modules','ignored.js'),'');
 await symlink(root,join(project,'loop'));
 const names=inspectorTools.map(x=>x.name);
 assert.equal(names.length,new Set(names).size,'unique MCP tools');
 for(const name of ['webview_inspect','runtime_doctor','apt_doctor','dev_environment_doctor','project_overview','project_dependency_graph','project_architecture_audit'])assert.ok(names.includes(name));
 const overview=await inspectorCall('project_overview',{root:project});
 assert.equal(overview.totalFiles,4);
 assert.equal(overview.languages.JavaScript.files,2);
 assert.ok(overview.manifests.includes('package.json'));
 const graph=await inspectorCall('project_dependency_graph',{root:project});
 assert.equal(graph.totalEdges,2);
 const audit=await inspectorCall('project_architecture_audit',{root:project});
 assert.equal(audit.cycles.length,1);
 assert.ok(audit.unresolvedLocalImports.some(x=>x.reference==='./nope.js'));
 const apt=await inspectorCall('apt_doctor',{probeCommands:false});
 assert.equal(apt.readOnly,true);
 assert.ok(apt.files.some(x=>x.path==='lib/libc++_shared.so'));
 assert.equal(apt.probes.length,0);
 const missingApt=await inspectorCall('apt_doctor',{probeCommands:true});
 assert.equal(missingApt.probes.length,5);
 assert.equal(missingApt.healthy,false);
 assert.equal(missingApt.failures.length,5);

 const dev=await inspectorCall('dev_environment_doctor',{probeCommands:false});
 assert.equal(dev.readOnly,true);
 assert.equal(dev.probes.length,0);
 assert.ok(dev.files.some(f=>f.path==='bin/qemu-x86_64'));
 assert.equal(typeof dev.capabilities.capNetRaw,'boolean');
 const runtime=await inspectorCall('runtime_doctor',{probeCommands:false,probeHost:false});
 assert.equal(runtime.commandChecks.length,0);
 assert.equal(runtime.host.skipped,true);
 assert.ok(runtime.checks.length>=8);
 // Simulate the native app replying to the private request directory.
 const requestDir=join(root,'webview-inspector','requests'),responseDir=join(root,'webview-inspector','responses');
 const nativeReply=(async()=>{
   for(let attempt=0;attempt<120;attempt++){
     const names=await readdir(requestDir).catch(()=>[]);
     const filename=names.find(x=>/^req-[0-9a-f]{32}\.json$/.test(x));
     if(filename){
       const req=JSON.parse(await readFile(join(requestDir,filename),'utf8'));
       assert.equal(req.operation,'snapshot');
       await writeFile(join(responseDir,'res-'+req.id+'.json'),
         JSON.stringify({id:req.id,ok:true,snapshot:{viewport:{width:420}}}));
       return;
     }
     await new Promise(done=>setTimeout(done,20));
   }
   throw new Error('WebView request not delivered');
 })();
 const positive=await inspectorCall('webview_inspect',{timeoutMs:4000});
 await nativeReply;
 assert.equal(positive.available,true);
 assert.equal(positive.viewport.width,420);
 // On desktop without a foreground WebView, this must fail cleanly instead of hanging.
 const snapshot=await inspectorCall('webview_inspect',{timeoutMs:500});
 assert.equal(snapshot.available,false);
 assert.match(snapshot.error,/WebView/);
 console.log('[DSH] Inspector tool contracts passed');
}finally{await rm(root,{recursive:true,force:true})}
