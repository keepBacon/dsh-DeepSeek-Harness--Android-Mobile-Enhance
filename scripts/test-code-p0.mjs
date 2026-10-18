import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {codeSemanticIndex,codeSymbolReferences,codeDependencyGraph,codeCallGraph,codeChangeImpact,codeRootCause,codePatchPlan,codeTestImpact} from './dsh-code-p0.mjs'
const assert=(ok,message)=>{if(!ok)throw Error(message)}
const root=await mkdtemp(join(tmpdir(),'dsh-p0-'));const old=process.env.DSH_CODE_INDEX_HOME;process.env.DSH_CODE_INDEX_HOME=join(root,'cache')
try{
 await mkdir(join(root,'src'));await mkdir(join(root,'tests'))
 await writeFile(join(root,'src','core.js'),'export function processData(){return 42}\n')
 await writeFile(join(root,'src','app.js'),'import {processData} from "./core.js"\nexport function start(){return processData()}\n')
 await writeFile(join(root,'tests','core.test.js'),'import {processData} from "../src/core.js"\n')
 const a={root},index=await codeSemanticIndex(a);assert(index.indexed===3,'index failed')
 const refs=await codeSymbolReferences({...a,symbol:'processData'});assert(refs.matches.some(x=>x.path==='src/app.js'),'references failed')
 const deps=await codeDependencyGraph(a);assert(deps.edges.some(e=>e.from==='src/app.js'&&e.to==='src/core.js'),'dependency failed')
 const calls=await codeCallGraph({...a,symbol:'processData'});assert(calls.definitions.some(x=>x.path==='src/core.js'),'call graph failed')
 const impact=await codeChangeImpact({...a,paths:['src/core.js']});assert(impact.possiblyAffected.includes('src/app.js'),'impact failed')
 const rootCause=await codeRootCause({...a,log:'src/core.js:2:3: error: unknown symbol'});assert(rootCause.rootCauseConfirmed===false,'fabricated root cause')
 const plan=await codePatchPlan({...a,paths:['src/core.js']});assert(plan.steps.length===4&&!plan.autoEdited,'patch plan unsafe')
 const tests=await codeTestImpact({...a,paths:['src/core.js']});assert(!tests.executed,'test impact executed unexpectedly')
 let rejected=false;try{await codeChangeImpact({...a,paths:['../escape']})}catch{rejected=true};assert(rejected,'path traversal accepted')
 console.log('[DSH] P0 eight analysis APIs self-test: OK')
}finally{if(old===undefined)delete process.env.DSH_CODE_INDEX_HOME;else process.env.DSH_CODE_INDEX_HOME=old;await rm(root,{recursive:true,force:true})}
