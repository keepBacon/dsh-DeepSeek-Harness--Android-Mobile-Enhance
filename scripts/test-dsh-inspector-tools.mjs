#!/usr/bin/env node
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,readdir,rm,symlink,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {inspectorTools,inspectorCall} from './dsh-inspector-tools.mjs';
const root=await mkdtemp(join(tmpdir(),'dsh-inspector-'));
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
 for(const name of ['webview_inspect','runtime_doctor','project_overview','project_dependency_graph','project_architecture_audit'])assert.ok(names.includes(name));
 const overview=await inspectorCall('project_overview',{root:project});
 assert.equal(overview.totalFiles,4);
 assert.equal(overview.languages.JavaScript.files,2);
 assert.ok(overview.manifests.includes('package.json'));
 const graph=await inspectorCall('project_dependency_graph',{root:project});
 assert.equal(graph.totalEdges,2);
 const audit=await inspectorCall('project_architecture_audit',{root:project});
 assert.equal(audit.cycles.length,1);
 assert.ok(audit.unresolvedLocalImports.some(x=>x.reference==='./nope.js'));
 const runtime=await inspectorCall('runtime_doctor',{probeCommands:false,probeHost:false});
 assert.equal(runtime.commandChecks.length,0);
 assert.equal(runtime.host.skipped,true);
 assert.ok(runtime.checks.length>=8);
 // On desktop without a foreground WebView, this must fail cleanly instead of hanging.
 const snapshot=await inspectorCall('webview_inspect',{timeoutMs:500});
 assert.equal(snapshot.available,false);
 assert.match(snapshot.error,/WebView/);
 console.log('[DSH] Inspector tool contracts passed');
}finally{await rm(root,{recursive:true,force:true})}
