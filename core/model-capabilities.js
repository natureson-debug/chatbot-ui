'use strict';
const {resourceUrl}=require('./context-telemetry');
const observations=new Map();
function cachedCapabilities(c,model,now=Date.now(),allowStale=false){
 const value=observations.get(JSON.stringify([c,model]));
 if(!value||(!allowStale&&(now-Date.parse(value.checkedAt)>300000||now<Date.parse(value.checkedAt))))return null;
 return structuredClone(value);
}
function classify(c,model,data,checkedAt){
 const entry=(state='unknown',method='not-declared',scope='native')=>({state,method,verifiedAt:state==='unknown'?null:checkedAt,scope});
 const capabilities={text:entry(),vision:entry(),tools:entry(),documents:entry('verified','application-document-to-text','application')};
 if(c.adapter==='ollama'&&Array.isArray(data?.capabilities)&&data.capabilities.length>0&&data.capabilities.every(x=>typeof x==='string')){
  for(const [key,flag] of [['text','completion'],['vision','vision'],['tools','tools']])capabilities[key]=entry(data.capabilities.includes(flag)?'verified':'unsupported','ollama-declared-capabilities');
 }
 if(c.adapter==='llama.cpp'){
  const identity=model===c.model?(c.backendModelIdentity??model):model;
  const matched=['model_alias','model_path'].some(k=>typeof data?.[k]==='string'&&data[k]===identity);
  // Accept explicit boolean modalities only; model names/templates are not evidence.
  if(matched&&data?.modalities&&typeof data.modalities.vision==='boolean')capabilities.vision=entry(data.modalities.vision?'verified':'unsupported','llama.cpp-props-modalities');
 }
 return {providerId:c.id,model,checkedAt,capabilities};
}
function createDiscovery(){
 const cache=new Map(),pending=new Map(),failures=new Map();
 return async function discover(c,model,{fetchImpl,secret,signal}={}){
  if(!require('./provider-models').list(c).some(m=>m.id===model))throw Error('Configured model required');
  const key=JSON.stringify([c,model]);
  if(failures.has(key)&&Date.now()-failures.get(key)<30000)throw Error("Model capability metadata unavailable");
  const old=cache.get(key);if(old&&Date.now()-old.time<15000)return structuredClone(old.value);
  if(pending.has(key))return structuredClone(await pending.get(key));
  if(pending.size>=4)throw Error('Capability discovery busy');
  const operation=(async()=>{
   let data=null;
   if(['ollama','llama.cpp'].includes(c.adapter)){
    const bounded=signal?AbortSignal.any([signal,AbortSignal.timeout(5000)]):AbortSignal.timeout(5000);
    const token=await secret(c);bounded.throwIfAborted();
    const response=await fetchImpl(resourceUrl(c.endpoint,c.adapter==='ollama'?'/api/show':'/props'),{
     method:c.adapter==='ollama'?'POST':'GET',redirect:'error',signal:bounded,
     headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},
     ...(c.adapter==='ollama'?{body:JSON.stringify({model,verbose:false})}:{})
    });
    if(!response.ok){await response.body?.cancel();throw Error('Unavailable');}
    const reader=response.body.getReader();let size=0;const chunks=[];
    try{for(;;){const {value,done}=await reader.read();if(done)break;size+=value.byteLength;if(size>1048576)throw Error('Too large');chunks.push(Buffer.from(value));}
     data=JSON.parse(Buffer.concat(chunks).toString('utf8'));
     if(!data||typeof data!=='object'||Array.isArray(data))throw Error('Invalid metadata');
    }finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
   }
   const value=classify(c,model,data,new Date().toISOString());
   if(observations.size>=100)observations.delete(observations.keys().next().value);
   observations.set(key,value);
   if(cache.size>=100)cache.delete(cache.keys().next().value);
   cache.set(key,{time:Date.now(),value});return value;
  })();
  pending.set(key,operation);
  try{return structuredClone(await operation);}catch{if(failures.size>=100)failures.delete(failures.keys().next().value);failures.set(key,Date.now());throw Error('Model capability metadata unavailable');}finally{pending.delete(key);}
 };
}
module.exports={classify,createDiscovery,cachedCapabilities};
