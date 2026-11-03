'use strict';
// Request-local observations only. Token totals are not context occupancy.
function normalize(chunk, previous = {}) {
 const t=chunk.timings || {}, u=chunk.usage || {};
 const number=x=>typeof x==='number'&&Number.isFinite(x)&&x>=0?x:null;
 const count=x=>Number.isSafeInteger(x)&&x>=0?x:null;
 const out={generatedTokens:count(t.predicted_n)??count(u.completion_tokens),
  generationSeconds:number(t.predicted_ms)===null?null:t.predicted_ms/1000,
  generationSpeed:number(t.predicted_per_second),promptTokens:count(t.prompt_n)??count(u.prompt_tokens),
  cachedTokens:count(t.cache_n)??count(u.prompt_tokens_details?.cached_tokens),
  contextTokens:null,contextLimit:null};
 for(const key of Object.keys(out)) if(out[key]===null)out[key]=previous[key]??null;
 if(out.generationSpeed===null&&out.generatedTokens!==null&&out.generationSeconds>0)out.generationSpeed=out.generatedTokens/out.generationSeconds;
 return out;
}
function stream(response, contextObservation = async()=>({contextUsedTokens:null,contextCapacityTokens:null})) {
 if(!response.ok || !response.body)return response;
 const reader=response.body.getReader(),decoder=new TextDecoder('utf-8',{fatal:true}),encoder=new TextEncoder();
 let buffer='',data=[],metrics={},ended=false;
 async function* events(){
  try{
   while(!ended){
    const {done,value}=await reader.read();buffer+=decoder.decode(value,{stream:!done});
    if(buffer.length>1048576)throw Error();
    let index;
    while((index=buffer.indexOf('\n'))>=0||done&&buffer.length){
     let line=index<0?buffer:buffer.slice(0,index);buffer=index<0?'':buffer.slice(index+1);line=line.replace(/\r$/,'');
     if(line.startsWith('data:'))data.push(line.slice(5).replace(/^ /,''));
     if(line===''&&data.length){yield* dispatch();if(ended)break;}
     if(data.join('').length>1048576)throw Error();
    }
    if(done){if(data.length)yield* dispatch();if(!ended)throw Error();}
   }
  }catch{throw Error('Provider stream unavailable');}
  finally{try{await reader.cancel();}finally{reader.releaseLock();}}
 }
 async function* dispatch(){
  const raw=data.join('\n');data=[];
  if(raw==='[DONE]'){ended=true;yield encoder.encode('data: '+JSON.stringify({choices:[],telemetry:{...normalize({},metrics),...await contextObservation()}})+'\n\ndata: [DONE]\n\n');return;}
  const chunk=JSON.parse(raw);if(!chunk||typeof chunk!=='object'||chunk.error)throw Error();
  if(chunk.timings||chunk.usage){metrics=normalize(chunk,metrics);chunk.telemetry=metrics;}
  yield encoder.encode('data: '+JSON.stringify(chunk)+'\n\n');
 }
 const iterator=events();
 return new Response(new ReadableStream({async pull(c){try{const n=await iterator.next();if(n.done)c.close();else c.enqueue(n.value);}catch{c.error(Error('Provider stream unavailable'));}},async cancel(){await reader.cancel();await iterator.return();}}),{status:response.status,headers:{'Content-Type':'text/event-stream'}});
}
module.exports={normalize,stream};
