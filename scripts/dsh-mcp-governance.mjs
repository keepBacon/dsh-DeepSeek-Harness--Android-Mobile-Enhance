/**
 * Mobile MCP P0: safe discover/audit/probe/validation/output limits.
 * Operates on the live exposed catalogue, never claims external Cordis plugins.
 * This module has no privileged filesystem or process side effects.
 */
const MAX_INPUT=256*1024,MAX_OUTPUT=2*1024*1024;
const SAFE_PROBES=new Set(['tool_registry_list','code_verify_recipes','reverse_capabilities','no_root_capabilities','tool_latency_report','mcp_server_health']);
const isObject=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const own=(obj,key)=>Object.prototype.hasOwnProperty.call(obj,key);
const clean=s=>String(s??'').slice(0,350).replace(/[\u0000-\u001f]/g,' ');
const finiteNumber=n=>typeof n==='number'&&Number.isFinite(n)&&(!Number.isInteger(n)||Number.isSafeInteger(n));
export function checkedJson(value,limit=MAX_OUTPUT) {
 const seen=new Set();
 function visit(v,depth){
  if(depth>36)throw Error('MCP_JSON_DEPTH_LIMIT');
  if(v===null||typeof v==='boolean'||typeof v==='string')return;
  if(finiteNumber(v))return;
  if(typeof v==='number')throw Error('MCP_JSON_UNSAFE_NUMBER');
  if(typeof v!=='object')throw Error('MCP_JSON_NOT_LOSSLESS');
  if(seen.has(v))throw Error('MCP_JSON_CIRCULAR');
  const proto=Object.getPrototypeOf(v);
  if(!Array.isArray(v)&&proto!==Object.prototype&&proto!==null)throw Error('MCP_JSON_NONPLAIN');
  seen.add(v);
  if(Array.isArray(v)){
   for(let i=0;i<v.length;i++){if(!own(v,i))throw Error('MCP_JSON_SPARSE_ARRAY');visit(v[i],depth+1)}
  }else for(const key of Object.keys(v))visit(v[key],depth+1);
  seen.delete(v);
 }
 visit(value,0);
 const text=JSON.stringify(value);
 if(typeof text!=='string'||Buffer.byteLength(text)>limit)throw Error('MCP_JSON_BUDGET_EXCEEDED');
 return text;
}
function validate(value,schema,where='$',depth=0){
 if(depth>24)throw Error('MCP_SCHEMA_DEPTH_LIMIT');
 if(!schema||typeof schema!=='object')return;
 const t=schema.type;
 if(Array.isArray(schema.enum)&&!schema.enum.some(x=>Object.is(x,value)))throw Error('MCP_SCHEMA_ENUM: '+where);
 if(t){
  const valid=t==='object'?isObject(value):t==='array'?Array.isArray(value):t==='integer'?Number.isSafeInteger(value):
   t==='number'?finiteNumber(value):t==='null'?value===null:typeof value===t;
  if(!valid)throw Error('MCP_SCHEMA_TYPE: '+where);
 }
 if(t==='object'){
  const props=schema.properties||{};
  for(const k of schema.required||[])if(!own(value,k))throw Error('MCP_SCHEMA_REQUIRED: '+where+'.'+k);
  for(const [k,v] of Object.entries(value)){
   if(own(props,k))validate(v,props[k],where+'.'+k,depth+1);
   else if(schema.additionalProperties===false)throw Error('MCP_SCHEMA_EXTRA: '+where+'.'+k);
   else if(isObject(schema.additionalProperties))validate(v,schema.additionalProperties,where+'.'+k,depth+1);
  }
 }
 if(t==='array'){
  if(schema.minItems!=null&&value.length<schema.minItems)throw Error('MCP_SCHEMA_MIN_ITEMS: '+where);
  if(schema.maxItems!=null&&value.length>schema.maxItems)throw Error('MCP_SCHEMA_MAX_ITEMS: '+where);
  if(schema.items)value.forEach((item,i)=>validate(item,schema.items,where+'['+i+']',depth+1));
 }
 if(t==='string'){
  if(schema.minLength!=null&&value.length<schema.minLength)throw Error('MCP_SCHEMA_MIN_LENGTH: '+where);
  if(schema.maxLength!=null&&value.length>schema.maxLength)throw Error('MCP_SCHEMA_MAX_LENGTH: '+where);
 }
 if((t==='integer'||t==='number')&&schema.minimum!=null&&value<schema.minimum)throw Error('MCP_SCHEMA_MINIMUM: '+where);
 if((t==='integer'||t==='number')&&schema.maximum!=null&&value>schema.maximum)throw Error('MCP_SCHEMA_MAXIMUM: '+where);
 if(Array.isArray(schema.oneOf)&&!schema.oneOf.some(option=>{try{validate(value,option,where,depth+1);return true}catch{return false}}))throw Error('MCP_SCHEMA_ONEOF: '+where);
}
export function validateToolInput(def,args){
 if(!isObject(args))throw Error('MCP_INPUT_OBJECT_REQUIRED');
 checkedJson(args,MAX_INPUT);
 validate(args,def.inputSchema);
}
export function catalogueAudit(defs,dispatcherSource=''){
 const declarations=defs.map(x=>x.name);
 const dups=declarations.filter((x,i)=>declarations.indexOf(x)!==i);
 const handlers=[...dispatcherSource.matchAll(/\bcase\s+'([^']+)'\s*:/g)].map(x=>x[1]);
 const missing=declarations.filter(x=>!handlers.includes(x));
 const undeclared=handlers.filter(x=>!declarations.includes(x));
 const malformed=defs.filter(t=>!t||typeof t.name!=='string'||!t.name||!isObject(t.inputSchema)||t.inputSchema.type!=='object');
 return {declarations:defs.length,handlers:handlers.length,duplicateNames:[...new Set(dups)],
  missingHandlers:missing,undeclaredHandlers:undeclared,malformed:malformed.map(x=>x?.name||'(unknown)'),
  consistent:!dups.length&&!missing.length&&!undeclared.length&&!malformed.length,
  scope:'mobile_tools only; external Cordis plugin handlers are not inspected'};
}
function rankTool(t,query){
 const q=query.toLowerCase().match(/[\p{L}\p{N}_-]+/gu)||[];
 const name=t.name.toLowerCase(),desc=(t.description||'').toLowerCase();
 return q.reduce((n,term)=>n+(name===term?12:name.includes(term)?7:0)+(desc.includes(term)?2:0),0);
}
export function createMcpGovernance({list,invoke,source='',telemetry}){
 if(typeof list!=='function'||typeof invoke!=='function')throw Error('catalogue/invoke required');
 const since=Date.now(),health={calls:0,errors:0,lastError:null};
 const lookup=name=>list().find(x=>x.name===name);
 function search(a={}){
  const query=String(a.query||'').trim();
  if(!query||query.length>160)throw Error('search query required (1..160 chars)');
  const limit=Number.isInteger(a.limit)?Math.max(1,Math.min(30,a.limit)):10;
  const matches=list().map(t=>({name:t.name,description:t.description||'',score:rankTool(t,query)}))
   .filter(t=>t.score>0).sort((a,b)=>b.score-a.score||a.name.localeCompare(b.name));
  return {query,total:matches.length,tools:matches.slice(0,limit),truncated:matches.length>limit,dynamic:true};
 }
 function audit(){
  const src=source(),all=list();
  // The runtime catalogue can be feature-filtered: audit declaration parity
  // against all registered definitions when caller supplies an unfiltered list.
  return catalogueAudit(all,src);
 }
 function status(){return {server:'mobile_tools',alive:true,uptimeMs:Date.now()-since,visibleTools:list().length,
  calls:health.calls,failed:health.errors,lastError:health.lastError,
  supportsToolIsolation:true,protocolUpgrade:'modern-stdio opt-in + legacy SDK'};
 }
 async function execute(name,args={},options={}){
  const tool=lookup(name);
  if(!tool)throw Error('MCP_TOOL_NOT_REGISTERED: '+clean(name));
  validateToolInput(tool,args);
  const start=Date.now();let ok=false;
  try{
   const value=await invoke(name,args);
   checkedJson(value);
   if(tool.outputSchema)validate(value,tool.outputSchema);
   ok=true;
   return value;
  }catch(e){
   health.errors++;health.lastError={tool:name,code:clean(e?.message),at:Date.now()};
   throw e;
  }finally{
   health.calls++;
   telemetry?.record(name,Date.now()-start,ok);
  }
 }
 async function probe(a={}){
  const name=String(a.name||'');
  const def=lookup(name);
  if(!def)return {name,status:'NOT_REGISTERED',called:false};
  if(!SAFE_PROBES.has(name))return {name,status:'UNSAFE_TO_PROBE',called:false,
   reason:'Read-only proof not established; do not auto-execute arbitrary tools'};
  try{const value=await execute(name,{},{});return {name,status:'OK',called:true,outputBytes:Buffer.byteLength(checkedJson(value))}}
  catch(e){return {name,status:'HANDLER_ERROR',called:true,error:clean(e.message)}}
 }
 return {execute,search,audit,status,probe,lookup,SAFE_PROBES};
}
