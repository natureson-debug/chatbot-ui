'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {chat,buildRequest,usage}=require('../core/deepseek-chat');
const config={id:'ds',name:'DeepSeek',adapter:'deepseek-chat',endpoint:'https://api.deepseek.com',credentialRef:'env:CHATBOT_DEEPSEEK_API_KEY',model:'deepseek-flash',parameters:['max_tokens','temperature'],capabilities:{streaming:true},contextLimit:null,models:[{id:'deepseek-flash',name:'Flash',enabled:true,chat:true,parameters:['max_tokens'],defaults:{max_tokens:64}}]};
const input={messages:[{role:'user',content:'Synthetic'}]};
test('DeepSeek non-streaming setting preserves normalized text, status and usage without reasoning',async()=>{
 let body,status;const events=[];
 const response=await chat({...config,streaming:false},input,{secret:async()=> 'synthetic',onDiagnostics:e=>status=e.httpStatus,onProgress:e=>events.push(e),fetchImpl:async(url,options)=>{body=JSON.parse(options.body);return new Response(JSON.stringify({choices:[{message:{role:'assistant',content:'OK',reasoning_content:'private'},finish_reason:'stop'}],usage:{prompt_tokens:2,completion_tokens:1}}),{headers:{'content-type':'application/json'}});}});
 const text=await response.text();assert.equal(body.stream,false);assert.equal(body.stream_options,undefined);assert.equal(status,200);assert(text.includes('OK'));assert(!text.includes('private'));assert.equal(events.at(-1).status,'completed');assert.equal(events.at(-1).usage.generatedTokens,1);
});
const chunk=(content,finish=null,extra={})=>'data: '+JSON.stringify({choices:[{index:0,delta:{content,reasoning_content:'not public'},finish_reason:finish}],...extra})+'\r\n\r\n';
const wire=': keep-alive\r\n\r\n'+chunk('Hello 🌍')+chunk(null,'stop',{usage:{prompt_tokens:9,completion_tokens:3,prompt_cache_hit_tokens:2}})+'data: [DONE]\r\n\r\n';
function transport(text=wire,fragment=1){return async()=>{const bytes=new TextEncoder().encode(text);let offset=0;return new Response(new ReadableStream({pull(c){if(offset===bytes.length)c.close();else{c.enqueue(bytes.slice(offset,offset+fragment));offset=Math.min(bytes.length,offset+fragment);}}}),{headers:{'content-type':'text/event-stream'}});};}
test('DeepSeek native request, auth, endpoint, cap and explicit text history',async()=>{
 let sent;const r=await chat(config,{...input,max_tokens:1024},{maxOutputTokens:128,secret:async()=> 'synthetic',fetchImpl:async(url,options)=>{sent={url,options};return transport()(url,options);}});await r.text();
 assert.equal(sent.url,'https://api.deepseek.com/chat/completions');assert.equal(sent.options.headers.Authorization,'Bearer synthetic');const body=JSON.parse(sent.options.body);assert.equal(body.max_tokens,128);assert.deepEqual(body.thinking,{type:'disabled'});assert.equal(body.stream_options.include_usage,true);assert.deepEqual(body.messages,input.messages);assert.equal(body.tools,undefined);assert.equal(sent.options.redirect,'error');
});
test('DeepSeek fragmented UTF8/CRLF SSE strips reasoning and emits exactly one completion',async()=>{
 const progress=[];const r=await chat(config,input,{secret:async()=> 'synthetic',fetchImpl:transport(),onProgress:e=>progress.push(e)});const output=await r.text();assert(output.includes('Hello 🌍'));assert(!output.includes('not public'));assert(!output.includes('reasoning_content'));assert.equal(output.split('[DONE]').length-1,1);assert.equal(progress.filter(e=>e.status).length,1);assert.equal(progress.at(-1).status,'completed');assert.equal(progress.at(-1).usage.cachedTokens,2);assert.equal(progress.at(-1).usage.contextUsedTokens,null);
});
test('DeepSeek usage-only final chunk and duplicate DONE never duplicate answer or terminal',async()=>{
 const text=chunk('Answer')+chunk(null,'stop')+'data: '+JSON.stringify({choices:[],usage:{prompt_tokens:2,completion_tokens:1}})+'\n\n'+'data: [DONE]\n\ndata: [DONE]\n\n';const r=await chat(config,input,{secret:async()=> 'synthetic',fetchImpl:transport(text,65536)});const out=await r.text();assert.equal(out.split('[DONE]').length-1,1);assert(out.includes('"promptTokens":2'));
});
test('DeepSeek missing or invalid usage remains unavailable, never context occupancy',()=>{
 for(const value of [null,{}, {prompt_tokens:-1,completion_tokens:'3',prompt_cache_hit_tokens:NaN}]){const result=usage(value,100);assert.equal(result.promptTokens,null);assert.equal(result.generatedTokens,null);assert.equal(result.cachedTokens,null);assert.equal(result.contextUsedTokens,null);}
 assert.equal(usage({prompt_tokens_details:{cached_tokens:0}},1).cachedTokens,0);
});
test('DeepSeek truncated/malformed streams fail closed and preserve partial progress',async()=>{
 for(const text of [chunk('Partial'),chunk('Partial')+'data: not JSON\n\n','data: [DONE]\n\n']){const r=await chat(config,input,{secret:async()=> 'synthetic',fetchImpl:transport(text)});const out=await r.text();assert(out.includes('"responseStatus":"interrupted"'));assert(!out.includes('[DONE]'));}
});
test('DeepSeek output limits and filtered responses are distinct from successful completion',async()=>{
 for(const [finish,status] of [['length','incomplete'],['content_filter','failed']]){const r=await chat(config,input,{secret:async()=> 'synthetic',fetchImpl:transport(chunk('Partial')+chunk(null,finish)+'data: [DONE]\n\n')});assert((await r.text()).includes('"responseStatus":"'+status+'"'));}
});
test('DeepSeek authentication, HTTP rate/model errors redact upstream bodies without retries',async()=>{
 for(const [status,code] of [[401,'AUTH'],[403,'AUTH'],[429,'RATE'],[404,'MODEL'],[500,'FAILED']]){let count=0;const r=await chat(config,input,{secret:async()=> 'synthetic',fetchImpl:async()=>{count++;return new Response('secret upstream diagnostic',{status});}});const text=await r.text();assert(text.includes('DEEPSEEK_'+code));assert(!text.includes('secret'));assert.equal(count,1);}
 let count=0;const r=await chat(config,input,{secret:async()=>{throw Error('private credential path');},fetchImpl:async()=>{count++;}});assert((await r.text()).includes('DEEPSEEK_AUTH'));assert.equal(count,0);
});
test('DeepSeek abort and deadline bound credential/transport waits',async()=>{
 for(const cancel of [true,false]){const controller=new AbortController();const pending=chat({...config,timeoutMs:20},input,{signal:controller.signal,secret:()=>new Promise(()=>{}),fetchImpl:()=>{throw Error('Must not dispatch');}});if(cancel)controller.abort();const keepAlive=setTimeout(()=>{},100);try{assert((await (await pending).text()).includes(cancel?'DEEPSEEK_CANCELLED':'DEEPSEEK_TIMEOUT'));}finally{clearTimeout(keepAlive);}}
});
test('DeepSeek rejects tools and unsafe configuration; legacy preset normalizes to gated native adapter',()=>{
 const validate=c=>require('../core/connections').validate({version:1,revision:0,defaultId:'ds',connections:[c]}).connections[0];
 for(const endpoint of ['http://api.deepseek.com','https://127.0.0.1','https://user:secret@api.deepseek.com','https://api.deepseek.com/?key=secret'])assert.throws(()=>validate({...config,endpoint}));
 assert.throws(()=>buildRequest(config,{...input,tools:[]}));assert.throws(()=>validate({...config,credentialRef:null}));assert.equal(validate({...config,adapter:'openai-compatible',providerType:'deepseek'}).adapter,'deepseek-chat');
});
test('DeepSeek feature gate is independent and rejects before credential resolution',async()=>{
 const previous=process.env.CHATBOT_DEEPSEEK_ENABLED;delete process.env.CHATBOT_DEEPSEEK_ENABLED;let reads=0;
 try{await assert.rejects(()=>require('../core/provider-adapter').createAdapter({secret:async()=>{reads++;},fetchImpl:async()=>{throw Error('No network');}}).chat(config,input));assert.equal(reads,0);}finally{if(previous===undefined)delete process.env.CHATBOT_DEEPSEEK_ENABLED;else process.env.CHATBOT_DEEPSEEK_ENABLED=previous;}
});
