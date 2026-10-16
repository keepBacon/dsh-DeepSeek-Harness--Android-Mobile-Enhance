/**
 * Local and bounded tool latency telemetry, disabled unless explicitly opted-in.
 * Never persists raw arguments, command output, API tokens or model messages.
 */
const MAX_SAMPLES=200
const MAX_TOOLS=80
const DEFAULT_WINDOW_MS=60*60*1000
const percentile=(s,p)=>s.length?s[Math.min(s.length-1,Math.ceil(s.length*p)-1)]:null
export function createToolTelemetry(options={}){
 const samples=[],enabled=options.enabled===true
 function record(name,durationMs,success=true){
  if(!enabled)return
  if(typeof name!=='string'||name.length>120||!Number.isFinite(durationMs))return
  samples.push({name,ms:Math.round(Math.max(0,durationMs)),ok:!!success,t:Date.now()})
  if(samples.length>MAX_SAMPLES)samples.splice(0,samples.length-MAX_SAMPLES)
 }
 function report(){
  const threshold=Date.now()-DEFAULT_WINDOW_MS
  const current=samples.filter(x=>x.t>=threshold)
  const grouped=new Map()
  for(const item of current){
   if(!grouped.has(item.name)){
    if(grouped.size>=MAX_TOOLS)continue
    grouped.set(item.name,[])
   }
   grouped.get(item.name).push(item)
  }
  const tools=[...grouped].map(([name,entries])=>{
   const latency=entries.map(x=>x.ms).sort((a,b)=>a-b)
   return{name,calls:entries.length,failures:entries.filter(x=>!x.ok).length,
    minMs:latency[0],p50Ms:percentile(latency,.5),p95Ms:percentile(latency,.95),
    maxMs:latency.at(-1),averageMs:Math.round(latency.reduce((a,b)=>a+b,0)/latency.length)}
  }).sort((a,b)=>b.calls-a.calls)
  return{enabled,volatile:true,windowMinutes:60,recorded:current.length,tools,
   note:'Durations only; no tool arguments, output, credentials or model data recorded.'}
 }
 return{record,report}
}
async function selfTest(){
 const off=createToolTelemetry()
 off.record('secret',200)
 if(off.report().recorded!==0)throw Error('default telemetry not disabled')
 const metrics=createToolTelemetry({enabled:true})
 metrics.record('code_verify',10,true);metrics.record('code_verify',30,false);metrics.record('fs_search',5,true)
 const r=metrics.report(),v=r.tools.find(x=>x.name==='code_verify')
 if(r.recorded!==3||v?.failures!==1||v.p50Ms!==10||v.p95Ms!==30||v.averageMs!==20)throw Error('telemetry aggregation failed')
 if(JSON.stringify(r).includes('secret'))throw Error('unexpected private detail')
 process.stdout.write('[DSH] Local MCP latency metrics self-test: OK\n')
}
if(process.argv.includes('--self-test'))selfTest().catch(e=>{console.error(e);process.exitCode=1})
