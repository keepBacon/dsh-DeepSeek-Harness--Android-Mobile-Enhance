// DSH Code Engine 2.0: AST + Language Service navigation and edits.
// Uses the pinned TypeScript compiler shipped with DSH developer tools.
// No network calls or separate MCP plugin; edits reuse the host transaction.
import { createRequire } from 'node:module'
import { join, resolve, dirname, relative, sep } from 'node:path'
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
]
const sha = x => createHash('sha256').update(x).digest('hex')
let compiler
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
 const bytes=await readFile(file)
 const content=new TextDecoder('utf-8',{fatal:true}).decode(bytes)
 if(content.includes('\u0000'))throw Error('binary source is unsupported: '+file)
 return {file,content,hash:sha(content)}
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
   const source=sources.get(resolve(file))?.content??ts.sys.readFile(file)
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
 const service=ts.createLanguageService(host,ts.createDocumentRegistry())
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
async function rename(args){
 if(!/^[A-Za-z_$][\w$]*$/.test(args.newName) || !typescript().isIdentifierText(args.newName,typescript().ScriptTarget.Latest))throw Error('newName must be a valid non-keyword JS/TS identifier')
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
  default:throw Error('unknown AST code tool: '+name)
 }
}
