// DSH Code Engine 2.0: AST + Language Service navigation and edits.
// Uses the pinned TypeScript compiler shipped with DSH developer tools.
// No network calls or separate MCP plugin; edits reuse the host transaction.
import { createRequire } from 'node:module'
import { join, resolve, dirname } from 'node:path'
import { readFile, stat } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { TextDecoder } from 'node:util'
import { codeCall } from './dsh-code-engine.mjs'

const require = createRequire(import.meta.url)
const field = {type:'string'}
const obj = (properties,required=[]) => ({type:'object',properties,required,additionalProperties:false})
const location = {file:field,line:{type:'integer',minimum:1},column:{type:'integer',minimum:1}}
const projects = {type:'array',items:field,minItems:1,maxItems:128}
export const codeAstTools = [
 {name:'code_ast_symbols',description:'AST declaration outline for JS/TS using TypeScript parser. Returns name, kind, line, column and symbol start offsets.',inputSchema:obj({file:field,maxResults:{type:'integer',minimum:1,maximum:500},includeNested:{type:'boolean'}},['file'])},
 {name:'code_ast_references',description:'Find same-symbol references using TypeScript language service, not text matches. Supply projectFiles for cross-file analysis.',inputSchema:obj({...location,projectFiles:projects,maxResults:{type:'integer',minimum:1,maximum:500}},['file','line','column'])},
 {name:'code_ast_rename',description:'Scope-aware JS/TS rename via TypeScript Language Service. Uses Code Engine multi-file transactional edits with dry run and stale hash detection.',inputSchema:obj({...location,newName:field,projectFiles:projects,dryRun:{type:'boolean'},maxFiles:{type:'integer',minimum:1,maximum:128}},['file','line','column','newName'])},
 {name:'code_ast_prepare_rename',description:'Check whether a selected JS/TS symbol can be renamed and report its actual semantic reference locations without editing.',inputSchema:obj({...location,projectFiles:projects,maxResults:{type:'integer',minimum:1,maximum:500}},['file','line','column'])},
 {name:'code_ast_diagnostics',description:'Collect TypeScript parser and semantic diagnostics for a selected JS/TS source using a project language service.',inputSchema:obj({file:field,projectFiles:projects,semantic:{type:'boolean'},maxResults:{type:'integer',minimum:1,maximum:200}},['file'])},
 {name:'code_ast_project_symbols',description:'Indexed AST declaration search across specified projectFiles (JS/TS), with locations and name filtering.',inputSchema:obj({file:field,projectFiles:projects,query:field,maxResults:{type:'integer',minimum:1,maximum:500}},['file'])},
]
const sha = x => createHash('sha256').update(x).digest('hex')
const KEYWORDS=new Set('await break case catch class const continue debugger default delete do else enum export extends false finally for function if import in instanceof let new null return super switch this throw true try typeof var void while with yield implements interface package private protected public static'.split(' '))
let compiler, documentRegistry
const CACHE_FILE_LIMIT=32
const CACHE_BYTES_LIMIT=24*1024*1024
const sourceCache=new Map()
let cacheBytes=0
function typescript(){
 if(compiler)return compiler
 const prefix=process.env.TERMUX__PREFIX||process.env.PREFIX||''
 const candidates=[
  process.env.DSH_CODE_TYPESCRIPT_PATH,
  prefix?join(prefix,'lib/dsh-dev-tools/node_modules/typescript/lib/typescript.js'):null,
  join(process.cwd(),'node_modules/typescript/lib/typescript.js'),
 ]
 for(const candidate of candidates)if(candidate){
  try{const ts=require(candidate);if(ts.createLanguageService&&ts.createSourceFile)return (compiler=ts)}
  catch(error){if(error?.code!=='MODULE_NOT_FOUND'&&error?.code!=='ENOENT')throw error}
 }
 try{const ts=require('typescript');if(ts.createLanguageService)return (compiler=ts)}catch{}
 throw Error('Code AST requires bundled typescript@5.9.3; rebuild the DSH developer tools runtime')
}
function isCode(file){return /\.(?:js|jsx|mjs|cjs|ts|tsx|mts|cts)$/i.test(file)}
async function readSource(path){
 const file=resolve(path)
 if(!isCode(file))throw Error('AST supports JS/TS source files only: '+file)
 const meta=await stat(file)
 if(!meta.isFile()||meta.size>16*1024*1024)throw Error('source is missing or larger than 16 MiB: '+file)
 const cached=sourceCache.get(file)
 if(cached && cached.size===meta.size && cached.mtimeMs===meta.mtimeMs && cached.ctimeMs===meta.ctimeMs && cached.ino===meta.ino){
  sourceCache.delete(file)
  sourceCache.set(file,cached)
  return cached
 }
 const bytes=await readFile(file)
 const content=new TextDecoder('utf-8',{fatal:true}).decode(bytes)
 if(content.includes('\u0000'))throw Error('binary source is unsupported: '+file)
 const result={file,content,hash:sha(content),size:meta.size,mtimeMs:meta.mtimeMs,ctimeMs:meta.ctimeMs,ino:meta.ino}
 if(cached){sourceCache.delete(file);cacheBytes-=cached.size}
 if(result.size<=CACHE_BYTES_LIMIT/2){
  sourceCache.set(file,result);cacheBytes+=result.size
  while(sourceCache.size>CACHE_FILE_LIMIT || cacheBytes>CACHE_BYTES_LIMIT){
   const oldest=sourceCache.keys().next().value
   const removed=sourceCache.get(oldest);sourceCache.delete(oldest);cacheBytes-=removed.size
  }
 }
 return result
}
function sourceKind(ts,file){
 if(/\.tsx$/i.test(file))return ts.ScriptKind.TSX
 if(/\.[mc]?ts$/i.test(file))return ts.ScriptKind.TS
 if(/\.jsx$/i.test(file))return ts.ScriptKind.JSX
 return ts.ScriptKind.JS
}
function spanLocation(ts,source,node){
 const offset=node.getStart(source)
 const point=source.getLineAndCharacterOfPosition(offset)
 return {line:point.line+1,column:point.character+1,offset,length:node.getWidth(source)}
}
function offsetFromLocation(source,line,column){
 if(!Number.isSafeInteger(line)||line<1||line>source.getLineAndCharacterOfPosition(source.end).line+1)throw Error('line out of source range')
 const start=source.getPositionOfLineAndCharacter(line-1,0)
 const end=source.getLineEndOfPosition(start)
 const position=start+column-1
 if(!Number.isSafeInteger(column)||column<1||position>=end+1)throw Error('column out of source range')
 return position
}
async function symbols(args){
 const ts=typescript(),file=await readSource(args.file)
 const source=ts.createSourceFile(file.file,file.content,ts.ScriptTarget.Latest,true,sourceKind(ts,file.file))
 const limit=Math.max(1,Math.min(500,args.maxResults||200)),result=[]
 const declarationKinds=[
  [ts.isFunctionDeclaration,'function'],[ts.isClassDeclaration,'class'],
  [ts.isInterfaceDeclaration,'interface'],[ts.isTypeAliasDeclaration,'type'],
  [ts.isEnumDeclaration,'enum'],[ts.isVariableDeclaration,'variable'],
  [ts.isMethodDeclaration,'method'],[ts.isPropertyDeclaration,'property'],
  [ts.isConstructorDeclaration,'constructor'],[ts.isFunctionExpression,'function_expression'],
 ]
 function visit(node,depth){
  if(result.length>=limit)return
  for(const [predicate,kind] of declarationKinds)if(predicate(node)){
   const name=node.name||node
   const point=spanLocation(ts,source,name)
   result.push({name:node.name?.getText(source)||'(anonymous)',kind,depth,...point,
    exported:!!node.modifiers?.some(x=>x.kind===ts.SyntaxKind.ExportKeyword)})
   break
  }
  if(args.includeNested===false&&depth>=1)return
  ts.forEachChild(node,child=>visit(child,depth+1))
 }
 ts.forEachChild(source,child=>visit(child,0))
 return {engine:'DSH Code Engine 2.0',strategy:'typescript-ast',file:file.file,sha256:file.hash,symbols:result,truncated:result.length>=limit,parseDiagnostics:source.parseDiagnostics.map(d=>({start:d.start,message:ts.flattenDiagnosticMessageText(d.messageText,'\n')})).slice(0,25)}
}
async function languageService(args){
 const ts=typescript(),selected=[resolve(args.file),...(args.projectFiles||[]).map(file=>resolve(file))]
 if(selected.length>129)throw Error('projectFiles exceeds 128')
 const sources=new Map()
 for(const file of new Set(selected)){const source=await readSource(file);sources.set(file,source)}
 const options={
  allowJs:true,checkJs:false,noEmit:true,skipLibCheck:true,
  target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.NodeNext,
  moduleResolution:ts.ModuleResolutionKind.NodeNext,jsx:ts.JsxEmit.Preserve,
 }
 const host={
  getScriptFileNames:()=>[...sources.keys()],
  getScriptVersion:file=>sources.get(resolve(file))?.hash||'0',
  getScriptSnapshot:file=>{
   const item=sources.get(resolve(file))
   if(item)return item.snapshot ||= ts.ScriptSnapshot.fromString(item.content)
   const source=ts.sys.readFile(file)
   return source===undefined?undefined:ts.ScriptSnapshot.fromString(source)
  },
  getCurrentDirectory:()=>dirname(resolve(args.file)),
  getCompilationSettings:()=>options,
  getDefaultLibFileName:opts=>ts.getDefaultLibFilePath(opts),
  fileExists:ts.sys.fileExists,
  readFile:ts.sys.readFile,
  readDirectory:ts.sys.readDirectory,
  directoryExists:ts.sys.directoryExists,
  getDirectories:ts.sys.getDirectories,
  useCaseSensitiveFileNames:()=>ts.sys.useCaseSensitiveFileNames,
  getNewLine:()=>ts.sys.newLine,
 }
 documentRegistry ||= ts.createDocumentRegistry()
 const service=ts.createLanguageService(host,documentRegistry)
 const file=resolve(args.file),source=sources.get(file)
 const parsed=ts.createSourceFile(file,source.content,ts.ScriptTarget.Latest,true,sourceKind(ts,file))
 const position=offsetFromLocation(parsed,args.line,args.column)
 return {ts,service,sources,file,position,parsed}
}
function summarizeReferences(ls,locations,maxResults){
 const result=[]
 for(const entry of locations){
  const path=resolve(entry.fileName)
  const source=ls.sources.get(path)
  if(!source)continue
  const parsed=ls.ts.createSourceFile(path,source.content,ls.ts.ScriptTarget.Latest,true,sourceKind(ls.ts,path))
  const lc=parsed.getLineAndCharacterOfPosition(entry.textSpan.start)
  result.push({path,line:lc.line+1,column:lc.character+1,offset:entry.textSpan.start,length:entry.textSpan.length,definition:!!entry.isDefinition})
  if(result.length>=maxResults)break
 }
 return result
}
async function references(args){
 const ls=await languageService(args)
 try{
  const found=ls.service.findReferences(ls.file,ls.position)||[]
  const places=found.flatMap(x=>x.references)
  const limit=Math.min(500,Math.max(1,args.maxResults||200))
  return {strategy:'typescript-language-service',path:ls.file,locations:summarizeReferences(ls,places,limit),total:places.length,truncated:places.length>limit}
 }finally{ls.service.dispose()}
}
async function prepareRename(args){
 const ls=await languageService(args)
 try{
  const info=ls.service.getRenameInfo(ls.file,ls.position,{allowRenameOfImportPath:false})
  if(!info.canRename)return {canRename:false,reason:info.localizedErrorMessage||'Rename is unavailable',file:ls.file}
  const locations=ls.service.findRenameLocations(ls.file,ls.position,false,false,true)||[]
  const max=Math.min(500,Math.max(1,args.maxResults||100))
  return {canRename:true,name:info.displayName,kind:info.kind,file:ls.file,referenceCount:locations.length,
   references:summarizeReferences(ls,locations,max),truncated:locations.length>max,strategy:'typescript-language-service'}
 }finally{ls.service.dispose()}
}
async function diagnostics(args){
 const ls=await languageService({...args,line:1,column:1})
 try{
  const ts=ls.ts,limit=Math.min(200,Math.max(1,args.maxResults||100))
  const raw=ls.service.getSyntacticDiagnostics(ls.file)
  if(args.semantic!==false)raw.push(...ls.service.getSemanticDiagnostics(ls.file))
  const items=raw.slice(0,limit).map(x=>{
   const file=x.file,position=file?.getLineAndCharacterOfPosition(x.start||0)
   return {code:x.code,category:ts.DiagnosticCategory[x.category]||String(x.category),
    line:position?.line===undefined?null:position.line+1,
    column:position?.character===undefined?null:position.character+1,
    length:x.length||0,message:ts.flattenDiagnosticMessageText(x.messageText,'\n')}
  })
  return {file:ls.file,strategy:'typescript-language-service',ok:!raw.some(x=>x.category===ts.DiagnosticCategory.Error),
   diagnostics:items,total:raw.length,truncated:raw.length>limit}
 }finally{ls.service.dispose()}
}
async function projectSymbols(args){
 const ts=typescript(),selected=[resolve(args.file),...(args.projectFiles||[]).map(file=>resolve(file))]
 if(selected.length>129)throw Error('projectFiles exceeds 128')
 const query=args.query==null?'':String(args.query).toLowerCase(),limit=Math.min(500,Math.max(1,args.maxResults||200))
 const result=[]
 for(const file of new Set(selected)){
  const input=await readSource(file)
  const tree=ts.createSourceFile(file,input.content,ts.ScriptTarget.Latest,true,sourceKind(ts,file))
  function visit(node){
   if(result.length>=limit)return
   const declaration=ts.isFunctionDeclaration(node)||ts.isClassDeclaration(node)||ts.isInterfaceDeclaration(node)||
    ts.isTypeAliasDeclaration(node)||ts.isEnumDeclaration(node)||ts.isVariableDeclaration(node)||
    ts.isMethodDeclaration(node)||ts.isPropertyDeclaration(node)
   if(declaration && node.name){
    const name=node.name.getText(tree)
    if(!query||name.toLowerCase().includes(query)){
     const location=spanLocation(ts,tree,node.name)
     result.push({file,name,kind:ts.SyntaxKind[node.kind],...location})
    }
   }
   ts.forEachChild(node,visit)
  }
  ts.forEachChild(tree,visit)
  if(result.length>=limit)break
 }
 return {strategy:'typescript-ast',symbols:result,truncated:result.length>=limit,filesScanned:selected.length}
}
async function rename(args){
 if(KEYWORDS.has(args.newName)||!/^[A-Za-z_$][\w$]*$/.test(args.newName) || !typescript().isIdentifierText(args.newName,typescript().ScriptTarget.Latest))throw Error('newName must be a valid non-keyword JS/TS identifier')
 const ls=await languageService(args)
 try{
  const info=ls.service.getRenameInfo(ls.file,ls.position,{allowRenameOfImportPath:false})
  if(!info.canRename)throw Error('cannot rename at this position: '+info.localizedErrorMessage)
  const locations=ls.service.findRenameLocations(ls.file,ls.position,false,false,true)||[]
  if(!locations.length)throw Error('no rename locations found')
  const grouped=new Map()
  for(const entry of locations){
   const path=resolve(entry.fileName)
   if(!ls.sources.has(path))throw Error('rename references file outside projectFiles; include: '+path)
   if(!grouped.has(path))grouped.set(path,[])
   grouped.get(path).push(entry)
  }
  if(grouped.size>(args.maxFiles||128))throw Error('rename spans too many files')
  const edits=[],summary=[]
  for(const [path,entries] of grouped){
   const source=ls.sources.get(path)
   let updated=source.content
   entries.sort((a,b)=>b.textSpan.start-a.textSpan.start)
   let right=Number.MAX_SAFE_INTEGER
   for(const entry of entries){
    const {start,length}=entry.textSpan
    if(start+length>right)throw Error('overlapping rename locations: '+path)
    const before=updated.slice(start,start+length)
    if(!before)throw Error('empty rename span')
    updated=updated.slice(0,start)+(entry.prefixText||'')+args.newName+(entry.suffixText||'')+updated.slice(start+length)
    right=start
   }
   if(source.content!==updated)edits.push({path,oldText:source.content,newText:updated,expectedSha256:source.hash})
   summary.push({path,locations:entries.length,beforeSha256:source.hash,afterSha256:sha(updated)})
  }
  if(!edits.length)throw Error('rename produced no source changes')
  const result=await codeCall('code_multi_edit',{edits,dryRun:args.dryRun===true})
  return {...result,strategy:'typescript-language-service',scopeAware:true,originalName:info.displayName,newName:args.newName,locations:locations.length,summary}
 }finally{ls.service.dispose()}
}
export async function codeAstCall(name,args={}){
 switch(name){
  case 'code_ast_symbols':return symbols(args)
  case 'code_ast_references':return references(args)
  case 'code_ast_rename':return rename(args)
  case 'code_ast_prepare_rename':return prepareRename(args)
  case 'code_ast_diagnostics':return diagnostics(args)
  case 'code_ast_project_symbols':return projectSymbols(args)
  default:throw Error('unknown AST code tool: '+name)
 }
}
