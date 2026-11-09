'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {validate}=require('../core/connections');
const {createAdapter,usable}=require('../core/provider-adapter');

const ollama=()=>({
 id:'mac-mini',name:'Mac mini Ollama',adapter:'ollama',
 endpoint:'http://127.0.0.1:11434/v1',model:'mistral:latest',credentialRef:null,
 parameters:['temperature','max_tokens'],
 capabilities:{streaming:true,thinking:false,vision:false,tools:false,models:true},
 contextLimit:null,privateNetwork:true,allowInsecureHttp:true,timeoutMs:null
});

function jsonResponse(data,status=200){return new Response(JSON.stringify(data),{status});}

test('ollama model discovery preserves exact ids and provider id',async()=>{
 let url;
 const a=createAdapter({secret:async()=>null,fetchImpl:async(u)=>{url=u;return jsonResponse({models:[{name:'qwen2.5:32b'},{name:'mistral:latest'},{name:'nomic-embed-text:latest'}]});}});
 const models=await a.models(ollama());
 assert.equal(url,'http://127.0.0.1:11434/api/tags');
 assert.deepEqual(models,[
  {id:'qwen2.5:32b',name:'qwen2.5:32b',providerId:'mac-mini'},
  {id:'mistral:latest',name:'mistral:latest',providerId:'mac-mini'},
  {id:'nomic-embed-text:latest',name:'nomic-embed-text:latest',providerId:'mac-mini'}
 ]);
});

test('ollama no-auth connection omits authorization and reports usable capabilities',async()=>{
 let headers;
 const a=createAdapter({secret:async()=>null,fetchImpl:async(_u,o)=>{headers=o.headers;return jsonResponse({models:[{name:'mistral:latest'}]});}});
 const result=await a.testConnection(ollama());
 assert.equal(result.ok,true);
 assert.equal(headers.Authorization,undefined);
 assert.equal(result.capabilities.models,true);
});

test('ollama chat uses native endpoint and preserves model and generation settings',async()=>{
 let url,body;
 const a=createAdapter({secret:async()=>null,fetchImpl:async(u,o)=>{url=u;body=JSON.parse(o.body);return new Response('data: [DONE]\n\n');}});
 await a.chat(ollama(),{messages:[{role:'user',content:'hi'}],temperature:0.4,max_tokens:128});
 assert.equal(url,'http://127.0.0.1:11434/api/chat');
 assert.equal(body.model,'mistral:latest');
 assert.equal(body.stream,true);
 assert.equal(body.options.temperature,0.4);
 assert.equal(body.options.num_predict,128);
});

test('ollama native streaming translates content and terminal completion to SSE',async()=>{
 const upstream=JSON.stringify({message:{content:'hello'},done:false})+'\n'+JSON.stringify({done:true})+'\n';
 const a=createAdapter({secret:async()=>null,fetchImpl:async()=>new Response(upstream)});
 const r=await a.chat(ollama(),{messages:[{role:'user',content:'hi'}]});
 const text=await r.text();assert.match(text,/hello/);assert.match(text,/data: \[DONE\]/);
});

test('slow first-request model loading completes within configured timeout',async()=>{
 const c={...ollama(),timeoutMs:5000};
 const a=createAdapter({secret:async()=>null,fetchImpl:async()=>{await new Promise(resolve=>setTimeout(resolve,30));return new Response('data: [DONE]\n\n');}});
 const r=await a.chat(c,{messages:[{role:'user',content:'hi'}]});
 assert.equal(r.ok,true);
});

test('ollama cancellation aborts the upstream request',async()=>{
 let seen;const controller=new AbortController();
 const a=createAdapter({secret:async()=>null,fetchImpl:async(_u,o)=>{seen=o.signal;return new Promise((_,reject)=>seen.addEventListener('abort',()=>reject(Error('Aborted')),{once:true}));}});
 const p=a.chat(ollama(),{messages:[{role:'user',content:'hi'}]},{signal:controller.signal});
 await new Promise(resolve=>setImmediate(resolve));controller.abort();
 await assert.rejects(p);
 assert.equal(seen.aborted,true);
});

test('ollama upstream timeout fails closed and redacts details',async()=>{
 let seen;const c={...ollama(),timeoutMs:20};
 const a=createAdapter({secret:async()=>null,fetchImpl:async(_u,o)=>{seen=o.signal;return new Promise((_,reject)=>seen.addEventListener('abort',()=>reject(Error('timeout secret')),{once:true}));}});
 await assert.rejects(a.chat(c,{messages:[{role:'user',content:'hi'}]}),e=>!String(e.message).includes('secret'));
 assert.equal(seen.aborted,true);
});

test('malformed ollama discovery and connection refusal fail closed',async()=>{
 await assert.rejects(createAdapter({secret:async()=>null,fetchImpl:async()=>new Response('not json')}).models(ollama()));
 await assert.rejects(createAdapter({secret:async()=>null,fetchImpl:async()=>{throw Error('connection refused')}}).testConnection(ollama()),e=>!String(e.message).includes('refused'));
});

test('broken ollama provider does not affect another provider adapter',async()=>{
 const broken=createAdapter({secret:async()=>null,fetchImpl:async()=>{throw Error('SECRET_FAILURE')}});
 const working=createAdapter({secret:async()=>null,fetchImpl:async()=>jsonResponse({data:[{id:'m'}]})});
 await assert.rejects(broken.models(ollama()),e=>!String(e.message).includes('SECRET'));
 const models=await working.models({...ollama(),id:'other',adapter:'generic-openai'});
 assert.deepEqual(models,[{id:'m',name:'m',providerId:'other'}]);
});

test('legacy local llama.cpp behavior remains preserved',()=>{
 const normalized=validate({version:1,revision:0,defaultId:'local',connections:[{id:'local',name:'Local',adapter:'llama.cpp-openai',endpoint:'http://127.0.0.1:8080/v1',model:'model.gguf',credentialRef:'local-api-key',parameters:['temperature','max_tokens'],capabilities:{streaming:true,thinking:true,vision:false,tools:false,models:false},contextLimit:null}]});
 assert.equal(normalized.connections[0].adapter,'llama.cpp');
 assert.equal(usable(normalized.connections[0]).thinking,true);
});
