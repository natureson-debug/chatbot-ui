'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
const {observe,llamaCapacity,ollamaCapacity}=require('../core/context-telemetry');
const {stream}=require('../core/completion-metrics');const {toSse}=require('../core/ollama-stream');
const c={adapter:'llama.cpp',model:'alias',endpoint:'https://fixture.invalid/prefix/v1'};
const observedProps={model_path:'C:\\AI\\models\\Qwen3-Coder-30B-A3B-Instruct-Q4_K_M.gguf',model_alias:'qwen:latest',default_generation_settings:{n_ctx:32768},total_slots:1};
test('live failure reproduction: GGUF path alias rejects requested qwen alias before rendering',async()=>{
 const actualProps={...observedProps,model_alias:observedProps.model_path};
 let sentModel;
 const {createAdapter}=require('../core/provider-adapter');
 const adapter=createAdapter({secret:async()=>null,fetchImpl:async(url,options)=>{
  if(options.method==='POST'){sentModel=JSON.parse(options.body).model;return new Response('data: {"choices":[{"delta":{"content":"fixture"}}]}\n\ndata: [DONE]\n\n');}
  assert(url.endsWith('/props'));return new Response(JSON.stringify(actualProps));
 }});
 const response=await adapter.chat({...c,model:'qwen:latest',parameters:[],capabilities:{}},{messages:[{role:'user',content:'fixture'}]});
 const events=(await response.text()).split('\n\n').filter(x=>x.startsWith('data: {')).map(x=>JSON.parse(x.slice(6)));
 assert.equal(sentModel,'qwen:latest');assert.equal(actualProps.default_generation_settings.n_ctx,32768);
 assert.equal(events.at(-1).telemetry.contextCapacityTokens,null);
 assert.equal(llamaCapacity(actualProps,null,actualProps.model_path),32768);
});
test('observed props alias verifies capacity without model metadata or discovery',async()=>{
 const requests=[];const result=await observe({...c,model:'qwen:latest'},{secret:async()=> 'synthetic',fetchImpl:async(url,options)=>{
  requests.push(url);assert(url.endsWith('/props'));assert.equal(options.headers.Authorization,'Bearer synthetic');return new Response(JSON.stringify(observedProps));
 }});assert.equal(requests.length,1);assert.deepEqual(result,{contextUsedTokens:null,contextCapacityTokens:32768});
});
test('props identity mismatch overrides otherwise matching discovery and never guesses alias from path',()=>{
 assert.equal(llamaCapacity({...observedProps,model_alias:'other'},{data:[{id:'qwen:latest'}]},'qwen:latest'),null);
 const {model_alias,...pathOnly}=observedProps;
 assert.equal(llamaCapacity(pathOnly,{data:[{id:'qwen:latest'}]},'qwen:latest'),null);
 assert.equal(llamaCapacity(pathOnly,null,observedProps.model_path),32768);
 assert.equal(llamaCapacity({...observedProps,model_alias:['qwen:latest']},null,'qwen:latest'),null);
});
test('verified props retains per-slot capacity for multiple slots and rejects invalid capacity',()=>{
 assert.equal(llamaCapacity({...observedProps,total_slots:4},null,'qwen:latest'),32768);
 for(const n of [undefined,null,0,-1,'32768',1.5,Infinity])assert.equal(llamaCapacity({...observedProps,default_generation_settings:{n_ctx:n}},null,'qwen:latest'),null);
});
test('verified props reaches final stream telemetry and shared display',async()=>{
 const {createAdapter}=require('../core/provider-adapter');
 const adapter=createAdapter({secret:async()=>null,fetchImpl:async(url,options)=>new Response(options.method==='POST'?'data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n':JSON.stringify(observedProps))});
 const response=await adapter.chat({...c,model:'qwen:latest',parameters:[],capabilities:{}},{messages:[{role:'user',content:'test'}]});
 const chunks=(await response.text()).split('\n\n').filter(x=>x.startsWith('data: {')).map(x=>JSON.parse(x.slice(6)));
 const telemetry=chunks.at(-1).telemetry;assert.equal(telemetry.contextCapacityTokens,32768);
 const source=fs.readFileSync('public/app.js','utf8'),ctx={};vm.createContext(ctx);vm.runInContext(source.slice(source.indexOf('function formatPartialTelemetry('),source.indexOf('function addMessage(')),ctx);
 assert(ctx.formatPartialTelemetry(telemetry).includes('Context: N/A / 32,768'));
});
test('llama uses per-slot runtime capacity without dividing by slots or using training/total limits',()=>{
 assert.equal(llamaCapacity({default_generation_settings:{n_ctx:16384},total_slots:4,n_ctx:65536,n_ctx_train:131072},{data:[{id:'alias'}]},'alias'),16384);
 assert.equal(llamaCapacity({n_ctx:65536,n_ctx_train:131072},{data:[{id:'alias'}]},'alias'),null);
 assert.equal(llamaCapacity({default_generation_settings:{n_ctx:16384}},{data:[{id:'other'}]},'alias'),null);
});
test('Ollama runtime allocation requires exact unique running model match',()=>{
 assert.equal(ollamaCapacity({models:[{model:'alias',context_length:8192}]},'alias'),8192);
 for(const models of [[{model:'other',context_length:8192}],[{model:'alias',context_length:'8192'}],[{model:'alias',context_length:1},{model:'alias',context_length:2}]])assert.equal(ollamaCapacity({models},'alias'),null);
});
test('capacity observations preserve origin/prefix, auth and timeout; usage remains unknown',async()=>{
 const seen=[];const result=await observe(c,{secret:async()=> 'synthetic',fetchImpl:async(url,o)=>{seen.push({url,...o});return new Response(JSON.stringify(url.endsWith('/props')?{default_generation_settings:{n_ctx:16384}}:{data:[{id:'alias'}]}));}});
 assert.equal(result.contextCapacityTokens,16384);assert.equal(result.contextUsedTokens,null);assert.equal(seen.length,2);for(const r of seen){assert(r.url.startsWith('https://fixture.invalid/prefix/'));assert.equal(r.redirect,'error');assert.equal(r.headers.Authorization,'Bearer synthetic');assert(r.signal);}
});
test('telemetry errors and cancellation are optional, sanitized and do not retry',async()=>{
 let calls=0;const controller=new AbortController();controller.abort();const options={signal:controller.signal,secret:async()=>null,fetchImpl:async()=>{calls++;throw Error('secret');}};assert.equal((await observe(c,options)).contextCapacityTokens,null);assert.equal(calls,0);
 assert.equal((await observe(c,{...options,signal:undefined})).contextCapacityTokens,null);assert.equal(calls,1);
});
test('context discovery never falls back to unprotected global fetch',async()=>{
 const original=globalThis.fetch;let calls=0;globalThis.fetch=async()=>{calls++;throw Error('unprotected global fetch');};
 try{
  const result=await observe(c,{secret:async()=>null});
  assert.deepEqual(result,{contextUsedTokens:null,contextCapacityTokens:null});
  assert.equal(calls,0);
 }finally{globalThis.fetch=original;}
});
test('llama and Ollama final streams attach capacity without converting token counters into usage',async()=>{
 const observed=async()=>({contextCapacityTokens:8192,contextUsedTokens:null});
 const llama=await stream(new Response('data: {"usage":{"prompt_tokens":20,"completion_tokens":10}}\n\ndata: [DONE]\n\n'),observed).text();
 const ollama=await toSse(new Response('{"done":true,"prompt_eval_count":20,"eval_count":10}\n'),observed).text();
 for(const text of [llama,ollama]){assert(text.includes('"contextCapacityTokens":8192'));assert(text.includes('"contextUsedTokens":null'));assert(text.includes('[DONE]'));}
});
test('shared context renderer supports all four states and ignores old inferred values',()=>{
 const source=fs.readFileSync('public/app.js','utf8'),ctx={};vm.createContext(ctx);vm.runInContext(source.slice(source.indexOf('function formatPartialTelemetry('),source.indexOf('function addMessage(')),ctx);
 for(const [t,expected] of [[{},'Context: N/A'],[{contextCapacityTokens:32768},'Context: N/A / 32,768'],[{contextUsedTokens:2688},'Context: 2,688 / N/A'],[{contextUsedTokens:2688,contextCapacityTokens:32768},'Context: 2,688 / 32,768']])assert(ctx.formatPartialTelemetry(t).includes(expected));
 assert(ctx.formatPartialTelemetry({contextTokens:500,contextLimit:8192}).includes('Context: N/A'));
});
