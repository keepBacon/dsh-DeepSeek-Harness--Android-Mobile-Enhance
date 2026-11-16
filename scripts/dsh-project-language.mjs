// DSH P1 source extraction. TypeScript/JavaScript use the bundled TypeScript
// syntax tree; other languages use conservative, explicitly marked heuristics.
// A symbol name match in a heuristic language is NEVER advertised as a resolved
// semantic reference. This module only reads supplied source strings.
import { createRequire } from 'node:module'
import { join } from 'node:path'
const require=createRequire(import.meta.url)
const EXT={
 '.js':'JavaScript','.jsx':'JavaScript','.mjs':'JavaScript','.cjs':'JavaScript',
 '.ts':'TypeScript','.tsx':'TypeScript','.mts':'TypeScript','.cts':'TypeScript',
 '.py':'Python','.kt':'Kotlin','.kts':'Kotlin','.java':'Java',
 '.c':'C','.h':'C/C++','.cc':'C++','.cpp':'C++','.cxx':'C++','.hpp':'C++','.hh':'C++',
 '.lua':'Lua','.luau':'Luau','.sh':'Shell','.bash':'Shell',
}
export const LANGUAGES=Object.freeze(EXT)
export function languageOf(path){return EXT[/\.[^./]+$/.exec(path)?.[0]?.toLowerCase()]||null}
let compiler
function tsCompiler(){
 if(compiler)return compiler
 const prefix=process.env.TERMUX__PREFIX||process.env.PREFIX||''
 const candidates=[process.env.DSH_CODE_TYPESCRIPT_PATH,
  prefix?join(prefix,'lib/dsh-dev-tools/node_modules/typescript/lib/typescript.js'):null,
  join(process.cwd(),'node_modules/typescript/lib/typescript.js'),'typescript']
 for(const file of candidates){if(!file)continue;try{
  const ts=require(file)
  if(ts.createSourceFile&&ts.isIdentifier)return (compiler=ts)
 }catch(e){if(e.code!=='MODULE_NOT_FOUND'&&e.code!=='ENOENT')throw e}}
 return null
}
const MAX_SYMBOLS=300,MAX_REFS=4000,MAX_IMPORTS=250, MAX_DIAGNOSTICS=30
const dedupe=(a,key)=>[...new Map(a.map(x=>[key(x),x])).values()]
function point(text,index){
 const before=text.slice(0,index),last=before.lastIndexOf('\n')
 return {line:(before.match(/\n/g)||[]).length+1,column:index-last,offset:index}
}
function tsParse(path,text){
 const ts=tsCompiler()
 if(!ts)return null
 const kind=/\.tsx$/.test(path)?ts.ScriptKind.TSX:/\.(?:ts|mts|cts)$/.test(path)?ts.ScriptKind.TS:/\.jsx$/.test(path)?ts.ScriptKind.JSX:ts.ScriptKind.JS
 const tree=ts.createSourceFile(path,text,ts.ScriptTarget.Latest,true,kind)
 const symbols=[],refs=[],imports=[]
 const names=new Map()
 const position=offset=>{const p=tree.getLineAndCharacterOfPosition(offset);return {line:p.line+1,column:p.character+1,offset}}
 const declaration=(node)=>{
  if(ts.isFunctionDeclaration(node))return 'function'
  if(ts.isClassDeclaration(node))return 'class'
  if(ts.isInterfaceDeclaration(node))return 'interface'
  if(ts.isTypeAliasDeclaration(node))return 'type'
  if(ts.isEnumDeclaration(node))return 'enum'
  if(ts.isMethodDeclaration(node))return 'method'
  if(ts.isPropertyDeclaration(node))return 'property'
  if(ts.isVariableDeclaration(node))return 'variable'
  if(ts.isConstructorDeclaration(node))return 'constructor'
  if(ts.isFunctionExpression(node))return 'function_expression'
  return null
 }
 function insertImport(value,node,type){
  if(typeof value!=='string'||imports.length>=MAX_IMPORTS)return
  imports.push({specifier:value,...position(node.getStart(tree)),kind:type})
 }
 function visit(node){
  const dk=declaration(node)
  if(dk&&node.name&&ts.isIdentifier(node.name)&&symbols.length<MAX_SYMBOLS){
   const name=node.name.text,pos=position(node.name.getStart(tree))
   symbols.push({name,kind:dk,...pos,
    exported:!!node.modifiers?.some(x=>x.kind===ts.SyntaxKind.ExportKeyword)})
   names.set(pos.offset,name)
  }
  if(ts.isIdentifier(node)&&refs.length<MAX_REFS){
   const offset=node.getStart(tree);refs.push({name:node.text,...position(offset),declaration:names.has(offset)})
  }
  if(ts.isImportDeclaration(node)||ts.isExportDeclaration(node)){
   const str=node.moduleSpecifier
   if(str&&ts.isStringLiteral(str))insertImport(str.text,str,ts.isImportDeclaration(node)?'import':'export')
  }else if(ts.isCallExpression(node)&&node.arguments.length){
   const arg=node.arguments[0]
   if(ts.isStringLiteral(arg)&&(node.expression.kind===ts.SyntaxKind.ImportKeyword||
    (ts.isIdentifier(node.expression)&&node.expression.text==='require')))
    insertImport(arg.text,arg,'require')
  }
  ts.forEachChild(node,visit)
 }
 ts.forEachChild(tree,visit)
 return {language:languageOf(path),parser:'typescript-ast',symbols,refs,imports,
  diagnostics:tree.parseDiagnostics.slice(0,MAX_DIAGNOSTICS).map(x=>({
   ...position(x.start||0),message:ts.flattenDiagnosticMessageText(x.messageText,'\n'),severity:'error'})),
  packageName:null,confidence:'syntax'}
}
function lineBased(path,text){
 const language=languageOf(path),symbols=[],refs=[],imports=[],diagnostics=[]
 const lines=text.split(/\r?\n/)
 let pkg=null,offset=0
 function symbol(name,kind,line,col,exported=false){
  if(!name||symbols.length>=MAX_SYMBOLS)return
  symbols.push({name,kind,line,column:col,offset:offset+col-1,exported})
 }
 function dep(name,kind,line,col){
  if(name&&imports.length<MAX_IMPORTS)imports.push({specifier:name,kind,line,column:col,offset:offset+col-1})
 }
 for(let i=0;i<lines.length;i++){
  const line=lines[i],number=i+1
  const trimmed=line.trim()
  const comment=trimmed.startsWith('//')||trimmed.startsWith('#')||trimmed.startsWith('--')||trimmed.startsWith('*')
  if(!comment){
   let m
   if(language==='Python'){
    if((m=/^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/.exec(line)))symbol(m[1],'function',number,line.indexOf(m[1])+1)
    else if((m=/^\s*class\s+([A-Za-z_]\w*)\b/.exec(line)))symbol(m[1],'class',number,line.indexOf(m[1])+1)
    if((m=/^\s*(?:from\s+([.\w]+)\s+import|import\s+([.\w]+))/.exec(line)))dep(m[1]||m[2], 'python-import',number,line.indexOf(m[1]||m[2])+1)
   }else if(language==='Kotlin'||language==='Java'){
    if((m=/^\s*package\s+([\w.]+)/.exec(line)))pkg=m[1]
    if((m=/^\s*import\s+(?:static\s+)?([\w.*]+)/.exec(line)))dep(m[1],'java-import',number,line.indexOf(m[1])+1)
    const klass=/(?:(?:public|private|protected|internal|abstract|open|data|sealed|final|enum|annotation|static)\s+)*(?:class|interface|object|enum\s+class|record)\s+([A-Za-z_]\w*)/g
    while((m=klass.exec(line)))symbol(m[1],'type',number,line.indexOf(m[1],m.index)+1)
    if(language==='Kotlin'){
     if((m=/\bfun\s+(?:<[^>]+>\s*)?(?:[\w.<>?]+\.)?([A-Za-z_]\w*)\s*\(/.exec(line)))symbol(m[1],'function',number,line.indexOf(m[1],m.index)+1)
     if((m=/\b(?:val|var)\s+([A-Za-z_]\w*)\b/.exec(line)))symbol(m[1],'property',number,line.indexOf(m[1],m.index)+1)
    }else if((m=/\b(?:public|private|protected|static|final|synchronized|native|abstract|\s)+[\w<>\[\],.?]+\s+([A-Za-z_]\w*)\s*\(/.exec(line))&&
      !/^\s*(?:if|for|while|switch|catch)\b/.test(line))symbol(m[1],'method',number,line.indexOf(m[1],m.index)+1)
   }else if(['C','C++','C/C++'].includes(language)){
    if((m=/^\s*#\s*include\s*["<]([^">]+)[">]/.exec(line)))dep(m[1],'include',number,line.indexOf(m[1])+1)
    if((m=/^\s*(?:typedef\s+)?(?:struct|class|enum|union)\s+([A-Za-z_]\w*)/.exec(line)))symbol(m[1],'type',number,line.indexOf(m[1])+1)
    // Function prototypes and definitions, not arbitrary call expressions.
    if((m=/^\s*(?:(?:static|inline|extern|constexpr|virtual|explicit|__attribute__\s*\([^)]*\))\s+)*(?:[\w:*&<>~]+\s+)+([A-Za-z_~]\w*)\s*\([^;]*\)\s*(?:const\b|noexcept\b|->\s*\w+|\{|;|$)/.exec(line))&&
      !/^\s*(?:if|while|for|switch|return)\b/.test(line))
      symbol(m[1],'function',number,line.indexOf(m[1],m.index)+1)
   }else if(language==='Lua'||language==='Luau'){
    if((m=/\b(?:local\s+)?function\s+([\w.:]+)/.exec(line)))symbol(m[1].split(/[.:]/).at(-1),'function',number,line.indexOf(m[1])+1)
    if((m=/\b(?:local\s+)?([A-Za-z_]\w*)\s*=\s*(?:function\s*\(|\{)/.exec(line)))symbol(m[1],'variable',number,line.indexOf(m[1])+1)
    if((m=/\brequire\s*\(?\s*["']([^"']+)["']/.exec(line)))dep(m[1],'require',number,line.indexOf(m[1])+1)
   }else if(language==='Shell'){
    if((m=/^\s*(?:function\s+)?([A-Za-z_]\w*)\s*\(\s*\)\s*(?:\{|$)/.exec(line)))symbol(m[1],'function',number,line.indexOf(m[1])+1)
    else if((m=/^\s*function\s+([A-Za-z_]\w*)\b/.exec(line)))symbol(m[1],'function',number,line.indexOf(m[1])+1)
    if((m=/^\s*(?:source|\.)\s+["']?([^\s"']+)/.exec(line)))dep(m[1],'source',number,line.indexOf(m[1])+1)
   }
   if(refs.length<MAX_REFS){
    // Word occurrences are only candidates; not a scope-aware reference set.
    const tokens=/\b[A-Za-z_][A-Za-z0-9_]*\b/g
    let token
    while((token=tokens.exec(line))&&refs.length<MAX_REFS)
     refs.push({name:token[0],line:number,column:token.index+1,offset:offset+token.index,declaration:false})
   }
  }
  offset+=line.length+1
 }
 return {language,parser:'bounded-line-heuristic',symbols:dedupe(symbols,x=>[x.offset,x.name,x.kind].join(':')),
  refs,imports,packageName:pkg,diagnostics,confidence:'heuristic'}
}
export function parseSource(path,text){
 const language=languageOf(path)
 if(!language)throw Error('unsupported source language: '+path)
 if(typeof text!=='string'||Buffer.byteLength(text)>1024*1024)throw Error('source exceeds 1 MiB')
 if((language==='JavaScript'||language==='TypeScript')){
  const ast=tsParse(path,text)
  if(ast)return ast
 }
 return lineBased(path,text)
}
