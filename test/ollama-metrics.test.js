'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {statistics,nativeEndpoint,toSse}=require('../core/ollama-stream');
const {createAdapter}=require('../core/provider-adapter');
const c={adapter:'ollama',endpoint:'https://example.invalid/proxy/v1',model:'selected',credentialRef:null,parameters:['temperature','max_tokens'],capabilities:{streaming:true},timeoutMs:5000};
test('native nanoseconds normalize to existing telemetry without inventing context/cache',()=>{
 const t=statistics({eval_count:40,eval_duration:2e9,prompt_eval_count:100,prompt_eval_duration:1e9,total_duration:4e9,load_duration:1e9});
 assert.deepEqual(t,{generatedTokens:40,generationSeconds:2,generationSpeed:20,promptTokens:100,cachedTokens:null,promptSeconds:1,totalSeconds:4,loadSeconds:1,contextTokens:null,contextLimit:null});
});
test('missing, malformed, negative, fractional and zero duration metrics stay unavailable',()=>{
 for(const bad of [undefined,null,'30',-1,NaN,Infinity,1.5]){const t=statistics({eval_count:bad,eval_duration:bad});assert.equal(t.generatedTokens,null);assert.equal(t.generationSpeed,null);}
 assert.equal(statistics({eval_count:10,eval_duration:0}).generationSpeed,null);
 assert.equal(statistics({prompt_eval_cached_count:0}).cachedTokens,0);
});
test('native URL retains origin and proxy prefix',()=>assert.equal(nativeEndpoint(c.endpoint),'https://example.invalid/proxy/api/chat'));
test('split UTF8, CRLF, trailing data and final metrics become SSE',async()=>{
 const bytes=Buffer.from(JSON.stringify({message:{content:'你好'},done:false})+'\r\n'+JSON.stringify({done:true,done_reason:'length',eval_count:2,eval_duration:1e9}));
 let i=0;const response=new Response(new ReadableStream({pull(controller){if(i===bytes.length)controller.close();else controller.enqueue(bytes.subarray(i,i+=1));}}));
 const text=await toSse(response).text();assert.match(text,/你好/);assert.match(text,/"generationSpeed":2/);assert.match(text,/"finish_reason":"length"/);assert.equal(text.split('[DONE]').length,2);
});
test('malformed and truncated native streams fail with sanitized errors',async()=>{
 for(const body of ['secret upstream garbage',JSON.stringify({done:false,message:{content:'partial'}})+'\n',JSON.stringify({error:'SECRET',done:true})])await assert.rejects(toSse(new Response(body)).text(),e=>e.message==='Provider stream unavailable');
});
test('native authentication, redirect restriction and vision mapping preserved',async()=>{
 let request;const a=createAdapter({secret:async()=> 'synthetic-secret',fetchImpl:async(url,o)=>{if(o.method==='POST')request={url,...o};return new Response('{"done":true}\n');}});
 const r=await a.chat({...c,capabilities:{vision:true}},{messages:[{role:'user',content:[{type:'text',text:'image'},{type:'image_url',image_url:{url:'data:image/png;base64,YQ=='}}]}],temperature:.5,max_tokens:32});
 await r.text();assert.equal(request.headers.Authorization,'Bearer synthetic-secret');assert.equal(request.redirect,'error');const b=JSON.parse(request.body);assert.deepEqual(b.messages[0].images,['YQ==']);assert.equal(b.options.num_predict,32);
});
test('downstream cancellation closes native reader',async()=>{
 let cancelled=false;const r=toSse(new Response(new ReadableStream({cancel(){cancelled=true;}})));await r.body.cancel();assert.equal(cancelled,true);
});
test('cancellation after response headers interrupts pending native stream reads',async()=>{
 const controller=new AbortController();
 const a=createAdapter({secret:async()=>null,fetchImpl:async(_url,options)=>new Response(new ReadableStream({start(stream){options.signal.addEventListener('abort',()=>stream.error(Error('private upstream details')),{once:true});}}))});
 const response=await a.chat(c,{messages:[{role:'user',content:'hi'}]},{signal:controller.signal});
 const reading=response.text();controller.abort();await assert.rejects(reading,e=>e.message==='Provider stream unavailable');
});
test('llama.cpp streaming preserves content and timings while normalizing metrics',async()=>{
 const body='data: '+JSON.stringify({choices:[{delta:{content:'hi'}}],timings:{predicted_n:2,predicted_ms:500,predicted_per_second:4,prompt_n:3,cache_n:0}})+'\n\ndata: [DONE]\n\n';
 const a=createAdapter({secret:async()=>null,fetchImpl:async(url)=>{assert.equal(url,c.endpoint+'/chat/completions');return new Response(body);}});
 const text=await (await a.chat({...c,adapter:'llama.cpp'},{messages:[{role:'user',content:'hi'}]})).text();assert(text.includes('"predicted_n":2'));assert(text.includes('"generatedTokens":2'));assert(text.includes('"content":"hi"'));
});
test('partial telemetry renderer uses existing presentation and never prints fabricated values',()=>{
 const fs=require('fs'),vm=require('vm'),source=fs.readFileSync('public/app.js','utf8');const context={};vm.createContext(context);vm.runInContext(source.slice(source.indexOf('function formatPartialTelemetry('),source.indexOf('function addMessage(')),context);
 assert.equal(context.formatPartialTelemetry(statistics({eval_count:40,eval_duration:2e9,prompt_eval_count:100})),'Generated: 40 • 20.0 t/s • 2.00 s | Context: N/A • Cached: N/A • Prompt: 100');
 assert(!context.formatPartialTelemetry({}).includes('undefined'));
});
