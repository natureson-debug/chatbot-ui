'use strict';
// Native DeepSeek Chat Completions. Only normalized answer text leaves this module.
const frame=value=>'data: '+JSON.stringify(value)+'\n\n';
function buildRequest(c,input,maxOutputTokens=1024){
 if(!Array.isArray(input.messages)||!input.messages.length||input.tools||input.useTools||input.previous_response_id)throw Error('Unsupported DeepSeek request');
 const messages=input.messages.map(m=>{
  if(!m||!['system','user','assistant'].includes(m.role)||typeof m.content!=='string')throw Error('DeepSeek supports text history only');
  return {role:m.role,content:m.content};
 });
 const requested=input.max_tokens??c.modelDefaults?.max_tokens??maxOutputTokens;
 if(!Number.isSafeInteger(requested)||requested<1||requested>32768||!Number.isSafeInteger(maxOutputTokens)||maxOutputTokens<1)throw Error('Invalid output limit');
 const body={model:c.model,messages,stream:c.streaming!==false,...(c.streaming!==false?{stream_options:{include_usage:true}}:{}),thinking:{type:'disabled'},max_tokens:Math.min(requested,maxOutputTokens)};
 if(c.parameters.includes('temperature')){
  const value=input.temperature??c.modelDefaults?.temperature;
  if(value!==undefined){if(typeof value!=='number'||!Number.isFinite(value)||value<0||value>2)throw Error('Invalid temperature');body.temperature=value;}
 }
 return body;
}
function usage(value,elapsed){
 const count=n=>Number.isSafeInteger(n)&&n>=0?n:null;
 return {promptTokens:count(value?.prompt_tokens),generatedTokens:count(value?.completion_tokens),cachedTokens:count(value?.prompt_cache_hit_tokens??value?.prompt_tokens_details?.cached_tokens),totalSeconds:elapsed/1000,generationSeconds:null,generationSpeed:null,contextUsedTokens:null,contextCapacityTokens:null};
}
function bounded(promise,signal){
 return new Promise((resolve,reject)=>{
  const abort=()=>reject(signal.reason);if(signal.aborted){abort();return;}
  signal.addEventListener('abort',abort,{once:true});
  Promise.resolve(promise).then(resolve,reject).finally(()=>signal.removeEventListener('abort',abort));
 });
}
async function chat(c,input,{fetchImpl,secret,signal,onProgress=()=>{},beforeSend=()=>{},maxOutputTokens,onDiagnostics=()=>{},clock=()=>performance.now()}={}){
 const body=buildRequest(c,input,maxOutputTokens),started=clock(),controller=new AbortController();
 const combined=AbortSignal.any([controller.signal,AbortSignal.timeout(c.timeoutMs||120000),...(signal?[signal]:[])]);
 const reason=()=>combined.aborted?(combined.reason?.name==='TimeoutError'?'timeout':'cancelled'):'network';
 const failure=code=>{
  const status=code==='cancelled'?'cancelled':['timeout','network','malformed'].includes(code)?'interrupted':'failed';
  onProgress({status});
  return frame({error:'DeepSeek request '+({auth:'credentials unavailable or rejected',rate:'rate limited',model:'model unavailable',timeout:'timed out',cancelled:'cancelled',network:'interrupted',malformed:'returned an invalid stream'}[code]||'failed')+'.',code:'DEEPSEEK_'+code.toUpperCase(),responseStatus:status});
 };
 let response;
 try{
  combined.throwIfAborted();let key;
  try{key=await bounded(secret(c),combined);}catch{if(combined.aborted)throw combined.reason;return new Response(failure('auth'));}
  if(typeof key!=='string'||!key.trim()||/[\r\n]/.test(key.trim()))return new Response(failure('auth'));
  combined.throwIfAborted();beforeSend();
  response=await bounded(Promise.resolve(fetchImpl(c.endpoint.replace(/\/$/,'')+'/chat/completions',{method:'POST',headers:{'Content-Type':'application/json',Accept:'text/event-stream',Authorization:'Bearer '+key.trim()},body:JSON.stringify(body),signal:combined,redirect:'error',beforeConnect:beforeSend})).then(r=>{if(combined.aborted)void r.body?.cancel().catch(()=>{});return r;}),combined);
  try{onDiagnostics({httpStatus:response.status});}catch{}
  if(!response.ok){void response.body?.cancel().catch(()=>{});return new Response(failure([401,403].includes(response.status)?'auth':response.status===429?'rate':response.status===404?'model':'failed'));}
  if(c.streaming===false){
   const r=response.body?.getReader();if(!r)return new Response(failure('malformed'));
   try{let text='',decoder=new TextDecoder('utf-8',{fatal:true});for(;;){const part=await bounded(r.read(),combined);text+=decoder.decode(part.value,{stream:!part.done});if(text.length>1048576)throw Error();if(part.done)break;}
    const result=JSON.parse(text),choice=result.choices?.[0];if(result.choices?.length!==1||choice?.message?.role!=='assistant'||typeof choice.message.content!=='string'||!['stop','length'].includes(choice.finish_reason))throw Error();
    const status=choice.finish_reason==='stop'?'completed':'incomplete',metrics=usage(result.usage,Math.max(0,clock()-started));if(choice.message.content)onProgress({text:choice.message.content});onProgress({status,usage:metrics});
    return new Response(frame({choices:[{delta:{content:choice.message.content},finish_reason:null}]})+frame({choices:[{delta:{},finish_reason:choice.finish_reason}],responseStatus:status,telemetry:metrics})+'data: [DONE]\n\n');
   }catch{return new Response(failure(combined.aborted?reason():'malformed'));}finally{controller.abort();void r.cancel().catch(()=>{});r.releaseLock();}
  }
  if(!response.body||!/^text\/event-stream(?:;|$)/i.test(response.headers.get('content-type')||'')){void response.body?.cancel().catch(()=>{});return new Response(failure('malformed'));}
 }catch{return new Response(failure(reason()));}
 const reader=response.body.getReader(),decoder=new TextDecoder('utf-8',{fatal:true}),encoder=new TextEncoder();
 let terminal=false,buffer='',data=[],size=0,total=0,finish=null,metrics=usage(null,0),phase='malformed';
 function dispatch(){
  const raw=data.join('\n');data=[];size=0;
  if(raw==='[DONE]'){
   if(!finish)throw Error('Missing finish reason');
   const status=finish==='stop'?'completed':finish==='length'?'incomplete':'failed';
   metrics.totalSeconds=Math.max(0,clock()-started)/1000;
   onProgress({status,usage:metrics});terminal=true;
   if(status==='failed')return frame({error:'DeepSeek response could not complete.',responseStatus:status,code:'DEEPSEEK_FAILED'});
   return frame({choices:[{delta:{},finish_reason:finish}],telemetry:metrics,responseStatus:status})+'data: [DONE]\n\n';
  }
  const event=JSON.parse(raw);
  if(!event||event.error||!Array.isArray(event.choices)||event.choices.length>1)throw Error('Invalid chunk');
  if(event.usage!=null){metrics=usage(event.usage,Math.max(0,clock()-started));onProgress({usage:metrics});}
  if(!event.choices.length)return '';
  const choice=event.choices[0];if(choice.index!==0||!choice.delta||typeof choice.delta!=='object')throw Error('Invalid choice');
  const text=choice.delta.content;
  if(text!=null&&typeof text!=='string')throw Error('Invalid content');
  if(finish&&(text||choice.finish_reason!=null))throw Error('Output after finish');
  if(choice.finish_reason!=null){if(!['stop','length','content_filter','tool_calls','insufficient_system_resource'].includes(choice.finish_reason))throw Error('Invalid finish');finish=choice.finish_reason;}
  total+=(text||'').length;if(total>4194304)throw Error('Output too large');
  // reasoning_content is deliberately neither forwarded nor persisted.
  if(text){onProgress({text});return frame({choices:[{delta:{content:text},finish_reason:null}]});}return '';
 }
 async function* events(){
  try{
   while(!terminal){
    phase='network';const {done,value}=await bounded(reader.read(),combined);phase='malformed';
    buffer+=decoder.decode(value,{stream:!done});if(buffer.length>1048576)throw Error('Oversized event');
    let newline;
    while((newline=buffer.indexOf('\n'))>=0||(done&&buffer.length)){
     const line=(newline<0?buffer:buffer.slice(0,newline)).replace(/\r$/,'');buffer=newline<0?'':buffer.slice(newline+1);
     if(line.startsWith('data:')){const part=line.slice(5).replace(/^ /,'');data.push(part);size+=part.length;if(size>1048576)throw Error('Oversized event');}
     if(!line&&data.length){const out=dispatch();if(out)yield encoder.encode(out);if(terminal)break;}
    }
    if(done){if(!terminal&&data.length){const out=dispatch();if(out)yield encoder.encode(out);}if(!terminal)throw Error('Truncated stream');}
   }
  }catch{if(!terminal){const out=failure(combined.aborted?reason():phase);terminal=true;yield encoder.encode(out);}}
  finally{controller.abort();void reader.cancel().catch(()=>{});reader.releaseLock();}
 }
 const iterator=events();
 return new Response(new ReadableStream({async pull(target){const next=await iterator.next();if(next.done)target.close();else target.enqueue(next.value);},async cancel(){controller.abort();void reader.cancel().catch(()=>{});await iterator.return();}}),{headers:{'Content-Type':'text/event-stream'}});
}
module.exports={chat,buildRequest,usage};
