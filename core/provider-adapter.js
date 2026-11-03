'use strict';
const fs=require('node:fs/promises');
const {API_KEY_FILE}=require('./paths');
const ollamaStream=require('./ollama-stream');
const completionMetrics=require('./completion-metrics');
const contextTelemetry=require('./context-telemetry');
const modelConfig=require('./provider-models');
const {createCloudFetch}=require('./cloud-transport');

async function credential(connection){
 if(connection.credentialRef===null)return null;
 const value=connection.credentialRef==='local-api-key'?await fs.readFile(API_KEY_FILE,'utf8'):process.env[connection.credentialRef.slice(4)];
 if(typeof value!=='string'||!value.trim()||/[\r\n]/.test(value.trim()))throw Error('Provider credential unavailable');return value.trim();
}

function usable(c){
 const openaiLike=c.adapter==='openai-compatible'||c.adapter==='ollama';
 return {
  streaming:modelConfig.ready(c),
  thinking:c.adapter==='llama.cpp'&&c.capabilities.thinking===true,
  vision:openaiLike&&c.capabilities.vision===true,
  tools:openaiLike&&c.capabilities.tools===true,
  models:c.capabilities.models===true
 };
}

function createAdapter({fetchImpl,secret=credential,onDiagnostics}={}){
 const transport=c=>fetchImpl||createCloudFetch({allowPrivate:c.privateNetwork===true,allowLoopback:require('./connections').isLoopback(new URL(c.endpoint).hostname),allowHttp:new URL(c.endpoint).protocol==='http:'&&(c.allowInsecureHttp===true||require('./connections').isLoopback(new URL(c.endpoint).hostname))});
 function validateMessages(c,input){
  if(!Array.isArray(input.messages))throw Error('Unsupported message content');
  const ok=input.messages.every(m=>m&&['system','user','assistant'].includes(m.role)&&(
   typeof m.content==='string'||
   usable(c).vision&&m.role==='user'&&Array.isArray(m.content)&&m.content.length>0&&m.content.length<=9&&
   m.content.every(p=>p.type==='text'&&typeof p.text==='string'||p.type==='image_url'&&typeof p.image_url?.url==='string'&&/^data:image\/(png|jpeg);base64,[A-Za-z0-9+/=]+$/.test(p.image_url.url)&&p.image_url.url.length<12000000)
  ));
  if(!ok)throw Error('Unsupported message content');
 }

 function buildChatBody(c,input){
  const body={model:c.model,messages:input.messages,stream:true};
  if(c.parameters.includes('temperature')){const n=input.temperature??c.modelDefaults?.temperature??0.7;if(typeof n!=='number'||!Number.isFinite(n)||n<0||n>2)throw Error('Invalid temperature');body.temperature=n;}
  if(c.parameters.includes('max_tokens')){const n=input.max_tokens??c.modelDefaults?.max_tokens??512;if(!Number.isSafeInteger(n)||n<1||n>32768)throw Error('Invalid token limit');body.max_tokens=n;}
  if(usable(c).thinking)body.chat_template_kwargs={enable_thinking:input.enable_thinking===true};
  if(c.adapter==='llama.cpp')body.stream_options={include_usage:true};
  return body;
 }

 async function request(c,resource,{signal,body,timeout=120000,returnResponse=false,native=false}={}){
  try{
   const key=await secret(c);
   const headers={'Content-Type':'application/json'};
   if(key){if(c.adapter==='anthropic-messages')headers['x-api-key']=key;else if(c.adapter==='gemini-native')headers['x-goog-api-key']=key;else headers.Authorization='Bearer '+key;}
   if(c.adapter==='anthropic-messages')headers['anthropic-version']='2023-06-01';
   const bounded=timeout===null?null:AbortSignal.timeout(timeout);
   const r=await transport(c)(native?ollamaStream.nativeEndpoint(c.endpoint):c.endpoint.replace(/\/$/,'')+'/'+resource,{
    method:body?'POST':'GET',headers,body:body?JSON.stringify(body):undefined,redirect:'error',
    signal:signal&&bounded?AbortSignal.any([signal,bounded]):signal||bounded||undefined
   });
   if(!r.ok&&!returnResponse){await r.body?.cancel();throw Error('Provider request failed');}
   return r;
  }catch{throw Error('Provider request unavailable');}
 }

 async function chat(c,input,{signal}={}){
  if(!modelConfig.ready(c))throw Error('Native inference adapter is not implemented yet');
  if(c.adapter==='openai-responses'){
   // Revalidate even direct adapter callers; never trust client-supplied approval.
   const validated=require('./connections').validate({version:1,revision:0,defaultId:c.id,connections:[c]}).connections[0];
   const selected=modelConfig.select(validated,c.model);
   return require('./openai-responses').chat(selected,input,{fetchImpl:transport(selected),secret,signal,onDiagnostics});
  }
  validateMessages(c,input);
  const body=buildChatBody(c,input);
  const timeout=c.legacy===true?null:(c.timeoutMs||120000);
  if(c.adapter==='ollama'){
   const messages=body.messages.map(m=>typeof m.content==='string'?m:{role:m.role,content:m.content.filter(p=>p.type==='text').map(p=>p.text).join('\n'),images:m.content.filter(p=>p.type==='image_url').map(p=>p.image_url.url.split(',')[1])});
   const options={};if(body.temperature!==undefined)options.temperature=body.temperature;if(body.max_tokens!==undefined)options.num_predict=body.max_tokens;
   const response=await request(c,'',{signal,body:{model:body.model,messages,stream:true,think:false,options},timeout,native:true});
   return ollamaStream.toSse(response,()=>contextTelemetry.observe(c,{fetchImpl:transport(c),secret,signal}));
  }
  return completionMetrics.stream(await request(c,'chat/completions',{signal,body,returnResponse:c.legacy===true,timeout}),()=>contextTelemetry.observe(c,{fetchImpl:transport(c),secret,signal}));
 }

 async function complete(c,input,{signal}={}){
  if(!modelConfig.ready(c)||!usable(c).tools)throw Error('Tools unsupported');
  const body={model:c.model,messages:input.messages,tools:input.tools,stream:false};
  if(c.parameters.includes('max_tokens'))body.max_tokens=512;
  const r=await request(c,'chat/completions',{body,signal,timeout:30000});
  let size=0,parts=[];
  for await(const b of r.body){size+=b.length;if(size>262144)throw Error('Provider response too large');parts.push(b);}
  try{
   const result=JSON.parse(Buffer.concat(parts).toString());
   const message=result.choices?.[0]?.message;
   if(!message||message.role!=='assistant')throw Error();
   return {...message,telemetry:{...completionMetrics.normalize(result),...await contextTelemetry.observe(c,{fetchImpl:transport(c),secret,signal})}};
  }catch{throw Error('Invalid provider completion');}
 }

 async function models(c,{signal}={}){
  if(!usable(c).models)throw Error('Model discovery unsupported');
  const r=await request(c,'models',{signal,timeout:5000});
  let size=0;const chunks=[];
  for await(const chunk of r.body){size+=chunk.length;if(size>262144)throw Error('Provider response too large');chunks.push(chunk);}
  try{
   const body=JSON.parse(Buffer.concat(chunks).toString());
   if(c.adapter==='gemini-native')body.data=body.models?.map(m=>({id:m.name}));
   if(!Array.isArray(body.data))throw Error();
   const seen=new Set();
   return body.data.slice(0,200).filter(m=>m&&typeof m.id==='string'&&m.id.length>0&&m.id.length<=512&&!seen.has(m.id)&&seen.add(m.id)).map(m=>({id:m.id,name:m.id,providerId:c.id}));
  }catch{throw Error('Invalid model discovery response');}
 }

 async function testConnection(c,{signal}={}){
  if(!usable(c).models)throw Error('Model discovery is not enabled for this provider');
  const discovered=await models(c,{signal});
  return {ok:true,models:discovered,capabilities:usable(c)};
 }

 return {usable,chat,complete,models,testConnection};
}

module.exports={...createAdapter(),createAdapter,usable};
