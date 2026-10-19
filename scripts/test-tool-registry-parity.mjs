#!/usr/bin/env node
/**
 * Fail CI if a mobile_tools declaration is not routed to its dispatcher.
 * Scoped to this MCP server. It cannot validate community Cordis plugins,
 * dynamically generated run_code bindings, or whether a handler is functional.
 */
import {readFile} from 'node:fs/promises'
import {fileURLToPath} from 'node:url'
import {resolve,dirname,join} from 'node:path'

export function auditDispatch(source) {
  const declarations=[...source.matchAll(/\{name:'([^']+)',description:/g)].map(x=>x[1])
  const handlers=[...source.matchAll(/\bcase\s+'([^']+)'\s*:/g)].map(x=>x[1])
  const duplicates=items=>items.filter((item,i)=>items.indexOf(item)!==i)
  const declared=new Set(declarations),routed=new Set(handlers)
  return {
    declarations:declarations.length,
    handlers:handlers.length,
    duplicateDeclarations:[...new Set(duplicates(declarations))],
    duplicateHandlers:[...new Set(duplicates(handlers))],
    unhandled:declarations.filter(name=>!routed.has(name)),
    undeclared:handlers.filter(name=>!declared.has(name)),
  }
}
export function assertDispatch(source) {
  const report=auditDispatch(source)
  if(!report.declarations||!report.handlers||
     report.duplicateDeclarations.length||report.duplicateHandlers.length||
     report.unhandled.length||report.undeclared.length){
    throw new Error('MCP dispatch mismatch: '+JSON.stringify(report))
  }
  return report
}
async function main(){
  const dir=dirname(fileURLToPath(import.meta.url))
  const source=await readFile(join(dir,'dsh-mobile-toolbox-mcp.mjs'),'utf8')
  const checked=assertDispatch(source)
  // Tests must detect both registration gaps and unreachable handler entries.
  const fake="{name:'one',description:'x'}\ncase 'one':\n"
  assertDispatch(fake)
  for(const invalid of [
    fake+"{name:'orphan',description:'x'}\n",
    fake+"case 'orphan':\n",
    fake+"{name:'one',description:'duplicate'}\n",
    fake+"case 'one':\n",
  ]){
    let caught=false
    try{assertDispatch(invalid)}catch{caught=true}
    if(!caught)throw new Error('dispatch audit failed to reject fixture')
  }
  process.stdout.write('[DSH] mobile_tools registry/handler parity: OK ('+
    checked.declarations+' declared, '+checked.handlers+' handlers)\n')
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  main().catch(e=>{console.error(e);process.exitCode=1})
}
