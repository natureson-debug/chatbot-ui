'use strict';
// Native Responses wire format. No provider events or response IDs reach clients.
const { performance } = require('node:perf_hooks');
const messages = {
 auth: 'OpenAI credentials are missing or invalid.', rate: 'OpenAI rate limit reached. Try again later.',
 model: 'The selected OpenAI model is unavailable.', timeout: 'OpenAI response timed out.',
 cancelled: 'Request cancelled.', network: 'OpenAI connection interrupted.',
 malformed: 'OpenAI returned an invalid response stream.', failed: 'OpenAI could not complete the response.',
 incomplete: 'OpenAI returned an incomplete response.'
};
const frame = value => 'data: ' + JSON.stringify(value) + '\n\n';
const failure = code => ({error: messages[code] || messages.failed, code: 'OPENAI_' + code.toUpperCase()});
function buildRequest(connection, input) {
 if (!Array.isArray(input.messages) || input.tools || input.previous_response_id || input.conversation || input.useTools) throw Error('Unsupported OpenAI request');
 const history = input.messages.map(m => {
  if (!m || !['system','developer','user','assistant'].includes(m.role) || typeof m.content !== 'string') throw Error('OpenAI supports text messages only');
  return {role:m.role, content:m.content};
 });
 const body = {model:connection.model, input:history, stream:true, store:false};
 // parameters is the selected model's administrator-verified allowlist.
 for (const name of connection.parameters) {
  const value = input[name] ?? connection.modelDefaults?.[name];
  if (value === undefined) continue;
  if (name === 'temperature') {
   if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 2) throw Error('Invalid temperature');
   body.temperature=value;
  } else if (name === 'max_tokens') {
   if (!Number.isSafeInteger(value) || value < 1 || value > 32768) throw Error('Invalid output limit');
   body.max_output_tokens=value;
  }
 }
 return body;
}
function usage(response, elapsed) {
 const count = n => Number.isSafeInteger(n) && n >= 0 ? n : null;
 return {promptTokens:count(response?.usage?.input_tokens), generatedTokens:count(response?.usage?.output_tokens),
  cachedTokens:count(response?.usage?.input_tokens_details?.cached_tokens),totalSeconds:Math.max(0,elapsed)/1000,
  generationSeconds:null,generationSpeed:null,contextUsedTokens:null,contextCapacityTokens:null};
}
function bounded(promise, signal) {
 return new Promise((resolve,reject) => {
  const abort=()=>reject(signal.reason); if(signal.aborted){abort();return;}
  signal.addEventListener('abort',abort,{once:true});
  Promise.resolve(promise).then(resolve,reject).finally(()=>signal.removeEventListener('abort',abort));
 });
}
function abortCode(signal) {return signal.reason?.name==='TimeoutError'?'timeout':'cancelled';}
async function chat(connection,input,{fetchImpl,secret,signal,onDiagnostics=()=>{},onProgress=()=>{},beforeSend=()=>{},maxOutputTokens,clock=()=>performance.now()}={}) {
 const body=buildRequest(connection,input), started=clock(),controller=new AbortController();
 if(maxOutputTokens!==undefined)body.max_output_tokens=Math.min(body.max_output_tokens??maxOutputTokens,maxOutputTokens);
 const deadline=AbortSignal.timeout(connection.timeoutMs || 120000);
 const combined=AbortSignal.any([controller.signal,deadline,...(signal?[signal]:[])]);
 const diagnostic = response => {
  const id=response?.id;
  if(typeof id==='string'&&/^resp_[A-Za-z0-9_-]{1,160}$/.test(id)) {
   try{onDiagnostics({providerResponseId:id,latencyMs:Math.max(0,clock()-started)});}catch{}
  }
 };
 const statusFor=code=>code==='cancelled'?'cancelled':['network','timeout','malformed'].includes(code)?'interrupted':code==='incomplete'?'incomplete':'failed';
 const failed=code=>{const status=statusFor(code);onProgress({status});return {...failure(code),responseStatus:status};};
 const responseError=code=>new Response(frame(failed(code)),{headers:{'Content-Type':'text/event-stream'}});
 let upstream;
 try {
  combined.throwIfAborted();
  let key;
  try{key=await bounded(secret(connection),combined);}catch{if(combined.aborted)throw combined.reason;return responseError('auth');}
  if(typeof key!=='string'||!key.trim()||/[\r\n]/.test(key.trim()))return responseError('auth');
  combined.throwIfAborted();
  beforeSend();
  upstream=await bounded(Promise.resolve(fetchImpl(connection.endpoint.replace(/\/$/,'')+'/responses',{
   method:'POST',headers:{'Content-Type':'application/json',Accept:'text/event-stream',Authorization:'Bearer '+key.trim()},
   body:JSON.stringify(body),signal:combined,redirect:'error',beforeConnect:beforeSend
  })).then(r=>{if(combined.aborted)void r.body?.cancel().catch(()=>{});return r;}),combined);
  if(!upstream.ok){void upstream.body?.cancel().catch(()=>{});return responseError([401,403].includes(upstream.status)?'auth':upstream.status===429?'rate':upstream.status===404?'model':'failed');}
  if(!upstream.body||!/^text\/event-stream(?:;|$)/i.test(upstream.headers.get('content-type')||'')){void upstream.body?.cancel().catch(()=>{});return responseError('malformed');}
 }catch{return responseError(combined.aborted?abortCode(combined):'network');}
 const reader=upstream.body.getReader(),decoder=new TextDecoder('utf-8',{fatal:true}),encoder=new TextEncoder();
 let terminal=false,buffer='',data=[],dataSize=0,lastSequence=-1,lastPart=-1,totalText=0,streamFailure='malformed';
 const parts=new Map();
 function dispatch(){
  const raw=data.join('\n');data=[];dataSize=0;
  const event=JSON.parse(raw);if(!event||typeof event.type!=='string')throw Error();
  if(event.sequence_number!==undefined){if(!Number.isSafeInteger(event.sequence_number)||event.sequence_number<0||event.sequence_number<=lastSequence)throw Error();lastSequence=event.sequence_number;}
  if(['response.created','response.in_progress'].includes(event.type)){onProgress({providerResponseId:event.response?.id});return '';}
  if(event.type==='response.output_text.delta'||event.type==='response.output_text.done'){
   if(!Number.isSafeInteger(event.output_index)||event.output_index<0||!Number.isSafeInteger(event.content_index)||event.content_index<0||event.content_index>9999)throw Error();
   const order=event.output_index*10000+event.content_index;if(!Number.isSafeInteger(order)||order<lastPart)throw Error();lastPart=order;
   const part=parts.get(order)||{text:'',done:false};let text;
   if(event.type.endsWith('.delta')){if(part.done||typeof event.delta!=='string')throw Error();text=event.delta;part.text+=text;}
   else {if(typeof event.text!=='string'||!event.text.startsWith(part.text))throw Error();text=event.text.slice(part.text.length);part.text=event.text;part.done=true;}
   totalText+=text.length;
   if(totalText>4194304||parts.size>1024)throw Error();parts.set(order,part);
   if(text)onProgress({text});
   return text?frame({choices:[{delta:{content:text},finish_reason:null}]}):'';
  }
  if(['response.completed','response.failed','response.incomplete'].includes(event.type)){
   const r=event.response;if(!r||r.status!==event.type.slice(9))throw Error();
   const status=event.type.slice(9),telemetry=usage(r,clock()-started);
   onProgress({status,usage:telemetry,providerResponseId:r.id});terminal=true;diagnostic(r);
   if(event.type==='response.failed')return frame({...failure('failed'),responseStatus:status});
   if(event.type==='response.incomplete'&&r.incomplete_details?.reason!=='max_output_tokens')return frame({...failure('incomplete'),responseStatus:status});
   return frame({responseStatus:status,choices:[{delta:{},finish_reason:status==='completed'?'stop':'length'}],telemetry})+'data: [DONE]\n\n';
  }
  if(event.type==='error'){const result=failed('failed');terminal=true;return frame(result);}
  return ''; // Future provider events, tools and reasoning are never forwarded.
 }
 async function* events(){
  try{
   while(!terminal){
    streamFailure='network';
    const {done,value}=await bounded(reader.read(),combined);
    streamFailure='malformed';
    buffer+=decoder.decode(value,{stream:!done});if(buffer.length>1048576)throw Error();
    let newline;
    while((newline=buffer.indexOf('\n'))>=0||(done&&buffer.length)){
     const line=(newline<0?buffer:buffer.slice(0,newline)).replace(/\r$/,'');buffer=newline<0?'':buffer.slice(newline+1);
     if(line.startsWith('data:')){const content=line.slice(5).replace(/^ /,'');data.push(content);dataSize+=content.length;if(dataSize>1048576)throw Error();}
     if(!line&&data.length){const output=dispatch();if(output)yield encoder.encode(output);if(terminal)break;}
    }
    if(done){if(!terminal&&data.length){const output=dispatch();if(output)yield encoder.encode(output);}if(!terminal)throw Error();}
   }
  }catch{if(!terminal){const result=failed(combined.aborted?abortCode(combined):streamFailure);terminal=true;yield encoder.encode(frame(result));}}
  finally{controller.abort();void reader.cancel().catch(()=>{});reader.releaseLock();}
 }
 const iterator=events();
 return new Response(new ReadableStream({
  async pull(c){const next=await iterator.next();if(next.done)c.close();else c.enqueue(next.value);},
  async cancel(){controller.abort();void reader.cancel().catch(()=>{});await iterator.return();}
 }),{headers:{'Content-Type':'text/event-stream'}});
}
module.exports={chat,buildRequest,usage};
