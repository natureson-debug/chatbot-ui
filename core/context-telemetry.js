'use strict';
const positive=n=>Number.isSafeInteger(n)&&n>0?n:null;
function ollamaCapacity(data,model){
 const matches=Array.isArray(data?.models)?data.models.filter(m=>m.model===model||m.name===model):[];
 return matches.length===1?positive(matches[0].context_length):null;
}
function llamaCapacity(props,models,model){
 // Prefer identity from the same observation as the capacity. Aliases are not
 // filenames; never compare basenames or infer an alias from a GGUF path.
 const hasIdentity=props && typeof props==='object' && ('model_alias' in props || 'model_path' in props);
 if(hasIdentity){
  if(typeof model!=='string'||!model ||
     !['model_alias','model_path'].some(key=>typeof props[key]==='string'&&props[key]===model))return null;
 }else if(!Array.isArray(models?.data)||models.data.length!==1||models.data[0].id!==model)return null;
 // default_generation_settings is a slot setting, not total server n_ctx.
 return positive(props?.default_generation_settings?.n_ctx);
}
function resourceUrl(endpoint,resource){
 const url=new URL(endpoint);url.pathname=url.pathname.replace(/\/$/,'').replace(/\/v1$/,'')+resource;return url.href;
}
async function observe(connection,{fetchImpl,secret,signal}={}){
 const unknown={contextUsedTokens:null,contextCapacityTokens:null};
 if(typeof fetchImpl!=='function'||!['llama.cpp','ollama'].includes(connection.adapter)||signal?.aborted)return unknown;
 try{
  const bounded=signal?AbortSignal.any([signal,AbortSignal.timeout(1500)]):AbortSignal.timeout(1500);
  const key=await secret(connection);bounded.throwIfAborted();
  const read=async resource=>{
   const response=await fetchImpl(resourceUrl(connection.endpoint,resource),{method:'GET',redirect:'error',signal:bounded,headers:key?{Authorization:'Bearer '+key}:{}});
   if(!response.ok){await response.body?.cancel();throw Error();}
   let size=0;const chunks=[];for await(const b of response.body){size+=b.length;if(size>262144)throw Error();chunks.push(b);}
   return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  };
  let capacity;
  if(connection.adapter==='ollama')capacity=ollamaCapacity(await read('/api/ps'),connection.model);
  else{
   const props=await read('/props');
   const hasIdentity=props && typeof props==='object' && ('model_alias' in props || 'model_path' in props);
   capacity=llamaCapacity(props,hasIdentity?null:await read('/v1/models'),connection.backendModelIdentity??connection.model);
  }
  return {...unknown,contextCapacityTokens:capacity};
 }catch{return unknown;}
}
module.exports={observe,ollamaCapacity,llamaCapacity,resourceUrl};
