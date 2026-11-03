'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {normalize,stream}=require('../core/completion-metrics');
const {createAdapter}=require('../core/provider-adapter');
const config={adapter:'llama.cpp',endpoint:'https://fixture.invalid/v1',model:'qwen:latest',credentialRef:null,parameters:[],capabilities:{},contextLimit:null};
const event=x=>'data: '+JSON.stringify(x)+'\r\n\r\n';
const parse=text=>text.split(/\n\n/).filter(x=>x.startsWith('data: {')).map(x=>JSON.parse(x.slice(6)));
test('complete timings normalize with unknown context instead of a token sum',()=>{
 assert.deepEqual(normalize({timings:{predicted_n:20,predicted_per_second:10,predicted_ms:2000,prompt_n:30,cache_n:8}}),{generatedTokens:20,generationSeconds:2,generationSpeed:10,promptTokens:30,cachedTokens:8,contextTokens:null,contextLimit:null});
});
test('partial usage and malformed timings are independent; zero cache is valid',()=>{
 const t=normalize({timings:{predicted_ms:-1,predicted_per_second:'10'},usage:{completion_tokens:7,prompt_tokens:9,prompt_tokens_details:{cached_tokens:0}}});
 assert.equal(t.generatedTokens,7);assert.equal(t.generationSpeed,null);assert.equal(t.generationSeconds,null);assert.equal(t.cachedTokens,0);assert.equal(t.contextTokens,null);
});
test('alias is preserved; usage requested; split UTF8 and usage-only final events normalize',async()=>{
 let request;const raw=Buffer.from(event({choices:[{delta:{content:'你好'},finish_reason:'stop'}],timings:{predicted_ms:2000}})+event({choices:[],usage:{completion_tokens:20,prompt_tokens:3}})+'data: [DONE]\n\n');let i=0;
 const a=createAdapter({secret:async()=>null,fetchImpl:async(_url,o)=>{request=JSON.parse(o.body);return new Response(new ReadableStream({pull(c){if(i===raw.length)c.close();else c.enqueue(raw.subarray(i,i+=1));}}));}});
 const events=parse(await(await a.chat(config,{messages:[{role:'user',content:'test'}]})).text());assert.equal(request.model,'qwen:latest');assert.deepEqual(request.stream_options,{include_usage:true});assert.equal(events[0].choices[0].delta.content,'你好');assert.equal(events.at(-1).telemetry.generatedTokens,20);assert.equal(events.at(-1).telemetry.generationSpeed,10);
});
test('absent statistics produce explicit unknown fields at DONE',async()=>{
 const events=parse(await stream(new Response(event({choices:[{delta:{content:'ok'}}]})+'data: [DONE]\n\n')).text());assert.equal(events.at(-1).telemetry.generatedTokens,null);assert.equal(events.at(-1).telemetry.contextTokens,null);
});
test('malformed or interrupted SSE fails sanitized',async()=>{
 for(const raw of ['data: private-invalid\n\n',event({choices:[]}),event({error:'private'})])await assert.rejects(stream(new Response(raw)).text(),e=>e.message==='Provider stream unavailable');
});
test('cancellation releases upstream and preserves non-OK responses',async()=>{
 let cancelled=false;const r=stream(new Response(new ReadableStream({cancel(){cancelled=true;}})));await r.body.cancel();assert(cancelled);const denied=new Response('denied',{status:401});assert.equal(stream(denied),denied);
});
test('non-streaming tool completion retains final-call metrics',async()=>{
 const a=createAdapter({secret:async()=>null,fetchImpl:async()=>new Response(JSON.stringify({choices:[{message:{role:'assistant',content:'answer'}}],usage:{completion_tokens:4,prompt_tokens:10}}))});
 const m=await a.complete({...config,adapter:'openai-compatible',capabilities:{tools:true}},{messages:[],tools:[]});assert.equal(m.telemetry.generatedTokens,4);assert.equal(m.telemetry.generationSpeed,null);
});
