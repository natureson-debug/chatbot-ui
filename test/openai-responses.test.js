'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const {createAdapter}=require('../core/provider-adapter'),native=require('../core/openai-responses');
const models=require('../core/provider-models'),catalog=require('../core/chat-models'),{validate}=require('../core/connections');
const originalGate=process.env.CHATBOT_OPENAI_RESPONSES_ENABLED;
test.beforeEach(()=>{process.env.CHATBOT_OPENAI_RESPONSES_ENABLED='1';});
test.after(()=>{if(originalGate===undefined)delete process.env.CHATBOT_OPENAI_RESPONSES_ENABLED;else process.env.CHATBOT_OPENAI_RESPONSES_ENABLED=originalGate;});
// Only injected transport is allowed in this test process.
const https=require('node:https'),originalRequest=https.request,originalFetch=global.fetch;
test.before(()=>{https.request=()=>{throw Error('Real network forbidden');};global.fetch=()=>{throw Error('Real network forbidden');};});
test.after(()=>{https.request=originalRequest;global.fetch=originalFetch;});
const connection=()=>({id:'fixture',name:'Fixture',adapter:'openai-responses',providerType:'openai',endpoint:'https://fixture.invalid/v1',model:'approved',credentialRef:'env:CHATBOT_TEST',parameters:['temperature','max_tokens'],capabilities:{streaming:true,models:true},contextLimit:null,models:[{id:'approved',name:'Approved',enabled:true,chat:true,parameters:['max_tokens'],defaults:{max_tokens:32}}]});
const config=c=>({version:1,revision:0,defaultId:c.id,connections:[c]});
const delta=text=>({type:'response.output_text.delta',output_index:0,content_index:0,delta:text});
const done=text=>({type:'response.output_text.done',output_index:0,content_index:0,text});
const completed=(extra={})=>({type:'response.completed',response:{id:'resp_fixture',status:'completed',...extra}});
const encode=events=>events.map(e=>'event: '+e.type+'\r\ndata: '+JSON.stringify(e)+'\r\n\r\n').join('');
function response(events,fragment=0){const bytes=new TextEncoder().encode(typeof events==='string'?events:encode(events));return new Response(new ReadableStream({start(c){for(let i=0;i<bytes.length;i+=fragment||bytes.length)c.enqueue(bytes.slice(i,i+(fragment||bytes.length)));c.close();}}),{headers:{'Content-Type':'text/event-stream'}});}
const parse=text=>text.split('\n\n').filter(Boolean).map(s=>s.slice(6)).map(s=>s==='[DONE]'?s:JSON.parse(s));
const textOf=events=>events.map(e=>e.choices?.[0]?.delta?.content||'').join('');
async function run(events,options={}){let calls=0;const a=createAdapter({secret:async()=> 'synthetic-only',fetchImpl:async()=>{calls++;return response(events,options.fragment);},onDiagnostics:options.onDiagnostics});const r=await a.chat(connection(),{messages:[{role:'user',content:'fixture'}]});return {events:parse(await r.text()),calls};}
test('native request uses explicit history, approved model, auth and parameter allowlist',async()=>{
 let request;const a=createAdapter({secret:async()=> 'synthetic-only',fetchImpl:async(url,o)=>{request={url,...o};return response([completed()]);}});
 const history=['system','developer','user','assistant'].map(role=>({role,content:role+' text'}));await(await a.chat(connection(),{messages:history,temperature:0.8,max_tokens:12})).text();
 assert.equal(request.url,'https://fixture.invalid/v1/responses');assert.equal(request.headers.Authorization,'Bearer synthetic-only');assert.equal(request.redirect,'error');assert.deepEqual(JSON.parse(request.body),{model:'approved',input:history,stream:true,store:false,max_output_tokens:12});
});
test('native parameters do not inherit the connection allowlist',()=>{
 const c=connection();delete c.models[0].parameters;assert.throws(()=>validate(config(c)),/defaults/);c.models[0].defaults={};const selected=models.select(validate(config(c)).connections[0],c.model);assert.deepEqual(selected.parameters,[]);assert.equal(native.buildRequest(selected,{messages:[],temperature:1,max_tokens:99}).max_output_tokens,undefined);
 selected.parameters=['temperature'];assert.equal(native.buildRequest(selected,{messages:[],temperature:0.2}).temperature,0.2);assert.throws(()=>native.buildRequest(selected,{messages:[],temperature:NaN}));
});
test('tools, remote conversation state and non-text input are rejected',async()=>{
 const a=createAdapter({secret:async()=>{throw Error('No credentials allowed');},fetchImpl:()=>{throw Error('No network');}});
 for(const bad of [{tools:[]},{previous_response_id:'resp_old'},{conversation:'state'},{useTools:true}])await assert.rejects(a.chat(connection(),{messages:[],...bad}));
 await assert.rejects(a.chat(connection(),{messages:[{role:'user',content:[]}]}));
});
test('fragmented UTF-8, CRLF, unknown events and duplicate done/terminals preserve text exactly once',async()=>{
 const events=[{type:'response.created'},{type:'response.in_progress'},delta('Hi '),{type:'future.unknown',secret:'not-forwarded'},delta('\u4f60\ud83d\ude00'),done('Hi \u4f60\ud83d\ude00'),done('Hi \u4f60\ud83d\ude00'),completed(),completed()];
 for(const fragment of [0,1,7]){const r=await run(events,{fragment});assert.equal(textOf(r.events),'Hi \u4f60\ud83d\ude00');assert.equal(r.events.filter(e=>e==='[DONE]').length,1);assert(!JSON.stringify(r.events).includes('not-forwarded'));assert.equal(r.calls,1);}
});
test('done-only text and trailing event without blank line are processed',async()=>{
 const r=await run(encode([done('Only'),completed()]).trimEnd());assert.equal(textOf(r.events),'Only');assert.equal(r.events.at(-1),'[DONE]');
});
test('usage is normalized and response ID is server-only',async()=>{
 const diagnostics=[];const r=await run([delta('OK'),completed({usage:{input_tokens:8,output_tokens:2,input_tokens_details:{cached_tokens:3}}})],{onDiagnostics:d=>diagnostics.push(d)});
 const t=r.events.find(e=>e.telemetry).telemetry;assert.equal(t.promptTokens,8);assert.equal(t.generatedTokens,2);assert.equal(t.cachedTokens,3);assert.equal(t.contextUsedTokens,null);assert.equal(t.contextCapacityTokens,null);assert.equal(t.generationSeconds,null);assert(t.totalSeconds>=0);assert.equal(diagnostics[0].providerResponseId,'resp_fixture');assert(!JSON.stringify(r.events).includes('resp_fixture'));
});
test('missing or malformed usage remains unavailable',async()=>{
 for(const usage of [undefined,{input_tokens:-1,output_tokens:'2',input_tokens_details:{cached_tokens:NaN}}]){const r=await run([completed({usage})]);const t=r.events.find(e=>e.telemetry).telemetry;assert.equal(t.promptTokens,null);assert.equal(t.generatedTokens,null);assert.equal(t.cachedTokens,null);}
});
test('provider failure, error and non-token incomplete produce one sanitized terminal',async()=>{
 for(const event of [{type:'response.failed',response:{status:'failed',error:{message:'synthetic-private'}}},{type:'error',message:'synthetic-private'},{type:'response.incomplete',response:{status:'incomplete',incomplete_details:{reason:'content_filter'}}}]){const r=await run([delta('partial'),event,completed()]);assert.equal(textOf(r.events),'partial');assert.equal(r.events.filter(e=>e.error).length,1);assert(!r.events.includes('[DONE]'));assert(!JSON.stringify(r.events).includes('synthetic-private'));}
});
test('token-limit incomplete preserves partial content and length notice',async()=>{
 const r=await run([delta('partial'),{type:'response.incomplete',response:{status:'incomplete',incomplete_details:{reason:'max_output_tokens'}}}]);assert.equal(r.events.at(-2).choices[0].finish_reason,'length');assert.equal(r.events.at(-1),'[DONE]');
});
test('malformed JSON/shape, contradictory done, sequence reversal and premature EOF fail safely',async()=>{
 for(const stream of ['data: {bad\n\n',encode([{type:'response.completed',response:{status:'failed'}}]),encode([delta('A'),done('B')]),encode([{...delta('A'),sequence_number:2},{...delta('B'),sequence_number:1}]),encode([delta('A')])]){const r=await run(stream);assert.equal(r.events.at(-1).code,'OPENAI_MALFORMED');assert.equal(r.events.filter(e=>e.error).length,1);}
});
test('HTTP auth/rate/model/network failures are sanitized with no retries',async()=>{
 for(const [status,code] of [[401,'AUTH'],[403,'AUTH'],[429,'RATE'],[404,'MODEL'],[500,'FAILED']]){let calls=0;const a=createAdapter({secret:async()=> 'synthetic-only',fetchImpl:async()=>{calls++;return new Response('synthetic-private',{status});}});const events=parse(await(await a.chat(connection(),{messages:[]})).text());assert.equal(events[0].code,'OPENAI_'+code);assert.equal(calls,1);assert(!JSON.stringify(events).includes('synthetic-private'));}
 const a=createAdapter({secret:async()=> 'synthetic-only',fetchImpl:async()=>{throw Error('synthetic-private');}});assert.equal(parse(await(await a.chat(connection(),{messages:[]})).text())[0].code,'OPENAI_NETWORK');
});
test('missing credential never invokes transport',async()=>{
 for(const secret of [async()=>null,async()=>{throw Error('synthetic-private');}]){let calls=0;const a=createAdapter({secret,fetchImpl:()=>calls++});assert.equal(parse(await(await a.chat(connection(),{messages:[]})).text())[0].code,'OPENAI_AUTH');assert.equal(calls,0);}
});
test('feature gate defaults off; disabled/unapproved/invalid configurations cannot invoke transport',async()=>{
 delete process.env.CHATBOT_OPENAI_RESPONSES_ENABLED;assert.equal(models.ready(connection()),false);assert.deepEqual(catalog.choices(config(connection())),[]);process.env.CHATBOT_OPENAI_RESPONSES_ENABLED='1';assert.equal(catalog.choices(config(connection())).length,1);
 for(const change of [c=>c.enabled=false,c=>c.models[0].enabled=false,c=>c.models[0].chat=false,c=>c.credentialRef=null,c=>c.endpoint='http://127.0.0.1:9999',c=>c.models=undefined]){const c=connection();change(c);let calls=0;const a=createAdapter({secret:async()=> 'synthetic-only',fetchImpl:()=>calls++});await assert.rejects(a.chat(c,{messages:[]}));assert.equal(calls,0);}
});
test('cancellation before credentials and during pending fetch cannot trigger retries',async()=>{
 const controller=new AbortController();let started;const pending=new Promise(r=>started=r);let upstreamSignal;const a=createAdapter({secret:async()=> 'synthetic-only',fetchImpl:async(_,o)=>{upstreamSignal=o.signal;started();return new Promise(()=>{});}});const result=a.chat(connection(),{messages:[]},{signal:controller.signal});await pending;controller.abort();assert.equal(parse(await(await result).text())[0].code,'OPENAI_CANCELLED');assert(upstreamSignal.aborted);
 let calls=0;const b=createAdapter({secret:async()=>{calls++;return 'synthetic';},fetchImpl:()=>calls++});await(await b.chat(connection(),{messages:[]},{signal:controller.signal})).text();assert.equal(calls,0);
});
test('client stream cancellation aborts upstream and closes reader',async()=>{
 let cancelled=false,signal;const a=createAdapter({secret:async()=> 'synthetic-only',fetchImpl:async(_,o)=>{signal=o.signal;return new Response(new ReadableStream({cancel(){cancelled=true;}}),{headers:{'Content-Type':'text/event-stream'}});}});const r=await a.chat(connection(),{messages:[]});await r.body.cancel();assert(signal.aborted);assert(cancelled);
});
test('startup and stream deadlines produce a timeout without retries',async()=>{
 const keep=setInterval(()=>{},1000);
 try{for(const streaming of [false,true]){let calls=0;const r=await native.chat({...models.select(connection(),'approved'),timeoutMs:15},{messages:[]},{secret:async()=> 'synthetic',fetchImpl:async()=>{calls++;return streaming?new Response(new ReadableStream(),{headers:{'Content-Type':'text/event-stream'}}):new Promise(()=>{});}});assert.equal(parse(await r.text())[0].code,'OPENAI_TIMEOUT');assert.equal(calls,1);}}finally{clearInterval(keep);}
});
test('actual HTTP chat route denies unauthenticated requests before accessing provider',async()=>{
 const s=fs.readFileSync('server.js','utf8'),block=s.slice(s.indexOf('    // Streaming chat proxy'),s.indexOf('// Return the currently authenticated user'));const ctx={getAuthenticatedUser:()=>null};vm.createContext(ctx);vm.runInContext('async function route(req,res){'+block+'}',ctx);let status;await ctx.route({method:'POST',url:'/api/chat'},{writeHead:s=>status=s,end(){}});assert.equal(status,401);
});
test('actual browser parser accepts normalized completion and surfaces error after partial text',async()=>{
 const source=fs.readFileSync('public/app.js','utf8'),start=source.indexOf('async function readAssistantStream('),end=source.indexOf('async function sendMessage()',start);const ctx={TextDecoder};vm.createContext(ctx);vm.runInContext(source.slice(start,end),ctx);let text='';
 const appBody=events=>new Response(events.map(e=>'data: '+(e==='[DONE]'?e:JSON.stringify(e))+'\n\n').join('')).body;
 const success=await run([delta('OK'),completed()]);await ctx.readAssistantStream(appBody(success.events).getReader(),c=>text+=c.choices?.[0]?.delta?.content||'');assert.equal(text,'OK');
 const failed=await run([delta('partial'),{type:'response.failed',response:{status:'failed'}}]);text='';await assert.rejects(ctx.readAssistantStream(appBody(failed.events).getReader(),c=>text+=c.choices?.[0]?.delta?.content||''),/could not complete/);assert.equal(text,'partial');
});

test('LF framing and multiple text parts retain ordering',async()=>{
 const r=await run(encode([delta('one'),done('one'),{...delta('two'),output_index:1},{...done('two'),output_index:1},completed()]).replaceAll('\r\n','\n'));
 assert.equal(textOf(r.events),'onetwo');
 const invalid=await run([{...delta('two'),output_index:1},delta('one')]);assert.equal(invalid.events.at(-1).code,'OPENAI_MALFORMED');
});
test('selected non-default approved model retains its own parameters and identifier',async()=>{
 const c=connection();c.models.push({id:'second',name:'Second',enabled:true,chat:true,parameters:[],defaults:{}});
 const selected=catalog.resolve(config(c),{providerId:c.id,model:'second'});let body;
 const a=createAdapter({secret:async()=> 'synthetic-only',fetchImpl:async(_,o)=>{body=JSON.parse(o.body);return response([completed()]);}});
 await(await a.chat(selected,{messages:[],max_tokens:20})).text();assert.equal(body.model,'second');assert.equal(body.max_output_tokens,undefined);
});
test('native text catalog cannot advertise unimplemented tools, vision or thinking',()=>{
 const c=connection();c.models[0].capabilities={tools:true,vision:true,thinking:true};const entry=catalog.choices(config(c))[0];
 for(const name of ['tools','vision','thinking'])assert.equal(entry.capabilities[name],false);
});
test('stream I/O failure is distinct from malformed provider data and does not expose details',async()=>{
 const a=createAdapter({secret:async()=> 'synthetic-only',fetchImpl:async()=>new Response(new ReadableStream({start(c){c.error(Error('synthetic-private'));}}),{headers:{'Content-Type':'text/event-stream'}})});
 const events=parse(await(await a.chat(connection(),{messages:[]})).text());assert.equal(events[0].code,'OPENAI_NETWORK');assert(!JSON.stringify(events).includes('synthetic-private'));
});
test('late response after cancellation is discarded and its body closed',async()=>{
 let release,started;const waiting=new Promise(r=>started=r),controller=new AbortController();let cancelled=false;
 const a=createAdapter({secret:async()=> 'synthetic-only',fetchImpl:()=>{started();return new Promise(r=>release=r);}});
 const pending=a.chat(connection(),{messages:[]},{signal:controller.signal});await waiting;controller.abort();assert.equal(parse(await(await pending).text())[0].code,'OPENAI_CANCELLED');
 release(new Response(new ReadableStream({cancel(){cancelled=true;}})));await new Promise(r=>setImmediate(r));assert(cancelled);
});
test('wrong content type and invalid UTF-8 cannot leak raw provider content',async()=>{
 for(const r of [new Response('synthetic-private'),new Response(new Uint8Array([255]),{headers:{'Content-Type':'text/event-stream'}})]){
  const a=createAdapter({secret:async()=> 'synthetic-only',fetchImpl:async()=>r});const out=parse(await(await a.chat(connection(),{messages:[]})).text());assert.equal(out[0].code,'OPENAI_MALFORMED');assert(!JSON.stringify(out).includes('synthetic-private'));
 }
});
test('cancellation after text preserves partial output and releases the pending stream',async()=>{
 const controller=new AbortController();let cancelled=false;
 const a=createAdapter({secret:async()=> 'synthetic-only',fetchImpl:async()=>new Response(new ReadableStream({start(c){c.enqueue(new TextEncoder().encode(encode([delta('partial')])));},cancel(){cancelled=true;}}),{headers:{'Content-Type':'text/event-stream'}})});
 const r=await a.chat(connection(),{messages:[]},{signal:controller.signal}),reader=r.body.getReader();const first=await reader.read();assert.equal(textOf(parse(new TextDecoder().decode(first.value))),'partial');controller.abort();let tail='';for(;;){const n=await reader.read();if(n.done)break;tail+=new TextDecoder().decode(n.value);}assert.equal(parse(tail)[0].code,'OPENAI_CANCELLED');assert(cancelled);
});
test('server cap overrides larger requested output and late admin disable prevents dispatch',async()=>{
 let body,calls=0;const a=createAdapter({secret:async()=> 'synthetic-only',fetchImpl:async(_,o)=>{calls++;body=JSON.parse(o.body);return response([completed()]);}});
 await(await a.chat(connection(),{messages:[],max_tokens:100},{maxOutputTokens:8})).text();assert.equal(body.max_output_tokens,8);
 await(await a.chat(connection(),{messages:[]},{beforeSend:()=>{throw Error('admin disabled');}})).text();assert.equal(calls,1);
});
