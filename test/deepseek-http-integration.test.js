'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),vm=require('node:vm');
const {fork}=require('node:child_process'),{randomBytes}=require('node:crypto'),{DatabaseSync}=require('node:sqlite');
const repo=path.resolve(__dirname,'..'),origin='http://127.0.0.1:4183';
const provider=(id,adapter,model)=>({id,name:id+' friendly',adapter,endpoint:'https://'+id+'.fixture.invalid/v1',model,credentialRef:'env:CHATBOT_SYNTHETIC_OPENAI',parameters:['max_tokens'],capabilities:{streaming:true,models:false},contextLimit:null,timeoutMs:1000,models:[{id:model,name:model+' friendly',enabled:true,chat:true,parameters:['max_tokens'],defaults:{max_tokens:32}}]});
function frontend(){
 // Reuse the existing actual-function frontend harness; no browser claim.
 const code=fs.readFileSync(path.join(__dirname,'frontend-revisions.test.js'),'utf8');
 const ctx={require,Buffer,structuredClone,TextDecoder,AbortController};vm.createContext(ctx);vm.runInContext(code.slice(0,code.indexOf("test('new chat")),ctx);return ctx.setup();
}
test('isolated authenticated DeepSeek HTTP qualification', {timeout:60000},async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'chatbot-mp05c1-'));
 const password=randomBytes(24).toString('hex'),key='synthetic-'+randomBytes(24).toString('hex');
 let child,events=[],log='',command=0;const waiters=new Set();
 const notify=()=>{for(const check of [...waiters])check();};
 const wait=(predicate,ms=5000)=>new Promise((resolve,reject)=>{const timer=setTimeout(()=>{waiters.delete(check);reject(Error('Fixture deadline exceeded'));},ms);const check=()=>{const value=predicate();if(value){clearTimeout(timer);waiters.delete(check);resolve(value);}};waiters.add(check);check();});
 async function stop(){if(!child)return;if(child.exitCode!==null){child=null;return;}const owned=child;const exited=new Promise(resolve=>owned.once('exit',resolve));owned.send({type:'shutdown'});await Promise.race([exited,new Promise((_,reject)=>{const timer=setTimeout(()=>reject(Error('Fixture shutdown timeout')),8000);timer.unref();})]);child=null;assert(events.some(e=>e.type==='shutdown'&&e.result.completed&&e.result.databaseClosed));}
 t.after(async()=>{try{await stop();}finally{if(child&&child.exitCode===null){const exited=new Promise(r=>child.once('exit',r));child.kill();await exited;}if(!path.resolve(root).startsWith(path.resolve(os.tmpdir())+path.sep))throw Error('Unsafe cleanup path');fs.rmSync(root,{recursive:true,force:true});}});
 for(const name of ['server.js','db.js','auth.js'])fs.copyFileSync(path.join(repo,name),path.join(root,name));
 for(const dir of ['core','public'])fs.cpSync(path.join(repo,dir),path.join(root,dir),{recursive:true});
 fs.copyFileSync(path.join(__dirname,'support/openai-http-child.cjs'),path.join(root,'bootstrap.cjs'));
 fs.writeFileSync(path.join(root,'.mp05b3-fixture'),'isolated');fs.mkdirSync(path.join(root,'data'));fs.mkdirSync(path.join(root,'home/config'),{recursive:true});
 const file=path.join(root,'data/chatbot.db'),db=new DatabaseSync(file);require('../core/database-schema').initializeSchema(db);db.prepare('INSERT INTO users(id,username,password_hash,is_admin) VALUES(?,?,?,1)').run('admin','synthetic-admin',require('../auth').hashPassword(password));db.close();
 async function start(gate='1',withKey=true){events=[];const env={SystemRoot:process.env.SystemRoot,PATH:process.env.PATH,TEMP:os.tmpdir(),TMP:os.tmpdir(),CHATBOT_PORT:'4183',CHATBOT_HOME:path.join(root,'home'),CHATBOT_DEEPSEEK_ENABLED:gate,...(withKey?{CHATBOT_SYNTHETIC_OPENAI:key}:{})};
  child=fork(path.join(root,'bootstrap.cjs'),[],{cwd:root,env,stdio:['ignore','pipe','pipe','ipc'],windowsHide:true});child.stdout.on('data',b=>log+=b);child.stderr.on('data',b=>log+=b);child.on('message',e=>{events.push(e);notify();});child.on('exit',code=>{events.push({type:'exited',code});if(code)console.error(log);notify();});const ready=await wait(()=>events.find(e=>e.type==='ready'||e.type==='startup-failed'));assert.equal(ready.type,'ready','Port 4183 must be available; no existing listener is stopped');assert.equal(ready.address.address,'127.0.0.1');}
 async function mode(value){const id=++command;child.send({type:'mode',mode:value,id});await wait(()=>events.find(e=>e.type==='ack'&&e.id===id));}
 async function release(){const id=++command;child.send({type:'release',id});await wait(()=>events.find(e=>e.type==='ack'&&e.id===id));}
 const request=(url,{cookie,body,method=body===undefined?'GET':'POST',signal}={})=>fetch(origin+url,{method,signal:signal||AbortSignal.timeout(5000),headers:{'Content-Type':'application/json',Origin:origin,'X-Chatbot-Action':url==='/api/admin/ai/deepseek-usage'?'configure-deepseek':'configure-connections',...(cookie?{Cookie:cookie}:{})},body:body===undefined?undefined:JSON.stringify(body)});
 const json=async(url,options,status=200)=>{const r=await request(url,options);assert.equal(r.status,status);return r.json();};
 async function login(username){const r=await request('/api/login',{body:{username,password}});assert.equal(r.status,200);const cookie=r.headers.get('set-cookie')?.split(';')[0];assert(cookie?.startsWith('chatbot_session='));await r.text();return cookie;}
 let admin,user,configuration,chatId;
 const selection={providerId:'deepseek',model:'second'};
 const chatBody=(pick=selection)=>({chatId,expectedRevision:0,selection:pick,messages:[{role:'user',content:'synthetic prompt'}],max_tokens:32});
 const history=()=>json('/api/chats/'+chatId+'/messages',{cookie:user});
 const responseEvents=text=>text.split('\n\n').filter(Boolean).map(e=>e.slice(6)).map(e=>e==='[DONE]'?e:JSON.parse(e));
 await start();
 await t.test('administrator login, regular account creation and provider configuration through actual HTTP',async()=>{
  admin=await login('synthetic-admin');await json('/api/admin/users',{cookie:admin,body:{username:'synthetic-user',password,role:'user'}},201);user=await login('synthetic-user');
  const cloud=provider('deepseek','deepseek-chat','second');cloud.providerType='deepseek';cloud.models.unshift({...cloud.models[0],id:'first',name:'First friendly'});cloud.models.push({...cloud.models[0],id:'disabled',enabled:false});
  configuration=await json('/api/admin/ai/connections',{cookie:admin,body:{version:1,revision:0,defaultId:'deepseek',connections:[cloud,provider('llama','llama.cpp','local-model'),provider('ollama','ollama','ollama-model')]}});
  await json('/api/admin/ai/deepseek-usage',{cookie:admin,body:{enabled:true,max_output_tokens:16,max_concurrent:1,per_hour:100,per_day:1000,estimated_daily_usd:null}});assert.equal(configuration.connections[0].model,'second');const list=await json('/api/ai/models',{cookie:user});assert.deepEqual(list.default,selection);assert(list.models.some(m=>m.model==='first'&&m.name==='First friendly'));assert(!list.models.some(m=>m.model==='disabled'));assert(!JSON.stringify(list).includes(key));assert(!JSON.stringify(configuration).includes(key));
 });
 await t.test('anonymous inference and non-admin configuration changes rejected',async()=>{
  await json('/api/chat',{body:chatBody()},401);await json('/api/admin/ai/connections',{cookie:user,body:configuration},403);assert(!events.some(e=>e.type==='request'));
 });
 await t.test('real frontend send and persistence against authenticated HTTP complete exactly once',async()=>{
  const chat=await json('/api/chats',{cookie:user,body:{}},201);chatId=chat.id;
  const h=frontend();h.c.chatStore={activeChatId:chatId,chats:{[chatId]:{title:'Fixture',messages:[],serverRevision:chat.revision}}};h.c.messages=h.c.chatStore.chats[chatId].messages;h.c.chatModelSelector={capture:()=>selection};h.c.intercept=(url,opt)=>request(url,{cookie:user,method:opt.method||'GET',body:opt.body?JSON.parse(opt.body):undefined,signal:opt.signal});
  await h.c.sendMessage();const rows=await history();assert.deepEqual(rows.map(m=>m.role),['user','assistant']);assert.equal(rows[1].content,'First second');assert.equal(rows[1].responseStatus,'completed');assert.equal(rows[1].telemetry.generatedTokens,2);assert.equal(rows[1].telemetry.promptTokens,9);assert.equal(rows[1].telemetry.cachedTokens,1);assert.equal(rows[1].telemetry.contextUsedTokens,null);assert.equal(h.saves().filter(x=>x.body.role==='assistant').length,0);
  await wait(()=>events.find(e=>e.type==='request'));const call=events.find(e=>e.type==='request');assert.equal(call.body.model,'second');assert.equal(call.body.max_tokens,16);assert(call.authorized);assert.equal(call.path,'/v1/chat/completions');assert(events.some(e=>e.type==='dns'));assert.equal(call.body.previous_response_id,undefined);
 });
 await t.test('authenticated reload and continued generation include prior user/assistant history',async()=>{
  const prior=await history(),h=frontend();h.c.intercept=(url,opt)=>request(url,{cookie:user,method:opt.method||'GET',body:opt.body?JSON.parse(opt.body):undefined,signal:opt.signal});h.c.chatStore=await h.c.prepareServerChatStore();h.c.chatStore.activeChatId=chatId;h.c.messages=h.c.chatStore.chats[chatId].messages;h.c.restoreChat();h.c.chatModelSelector={capture:()=>selection};h.c.promptBox.value='second turn';await h.c.sendMessage();
  const rows=await history();assert.equal(rows.length,4);assert.deepEqual(rows.slice(0,2),prior);const call=events.filter(e=>e.type==='request').at(-1);assert(call.body.messages.some(m=>m.role==='assistant'&&m.content==='First second'));assert(call.body.messages.some(m=>m.role==='user'&&m.content==='second turn'));
 });
 await t.test('saved selection survives actual isolated application restart',async()=>{
  const settings=await json('/api/settings',{cookie:user});settings.modelSelection=selection;await json('/api/settings',{cookie:user,body:settings});await stop();await start();assert.deepEqual((await json('/api/settings',{cookie:user})).modelSelection,selection);assert.equal((await history()).length,4);
 });
 await t.test('disabled, missing and removed selections fail before credentials or requests',async()=>{
  for(const model of ['disabled','missing'])await json('/api/chat',{cookie:user,body:chatBody({providerId:'deepseek',model})},400);
  const next=structuredClone(configuration);next.connections[0].models=next.connections[0].models.filter(m=>m.id!=='first');configuration=await json('/api/admin/ai/connections',{cookie:admin,body:next});await json('/api/chat',{cookie:user,body:chatBody({providerId:'deepseek',model:'first'})},400);assert(!events.some(e=>e.type==='credential'||e.type==='request'));
 });
 await t.test('text streams incrementally with one terminal and no duplicate done text',async()=>{
  await mode('hold');const r=await request('/api/chat',{cookie:user,body:chatBody()}),reader=r.body.getReader();const first=new TextDecoder().decode((await reader.read()).value);assert(first.includes('First '));assert(!first.includes('[DONE]'));await release();let text=first;for(;;){const n=await reader.read();if(n.done)break;text+=new TextDecoder().decode(n.value);}const out=responseEvents(text);assert.equal(out.filter(e=>e==='[DONE]').length,1);assert.equal(out.map(e=>e.choices?.[0]?.delta?.content||'').join(''),'First second');await mode('complete');
 });
 await t.test('application default routes to the non-first model, never its friendly name',async()=>{
  const r=await request('/api/chat',{cookie:user,body:{chatId,expectedRevision:0,messages:[{role:'user',content:'default selection'}]}});assert.equal(decodeURIComponent(r.headers.get('x-chat-model')),'second');await r.text();assert.equal(events.filter(e=>e.type==='request').at(-1).body.model,'second');
 });
 await t.test('provider failure before text does not create a successful assistant row',async()=>{
  await mode('failed');const before=await history(),h=frontend();h.c.chatStore={activeChatId:chatId,chats:{[chatId]:{title:'Fixture',messages:[],serverRevision:0}}};h.c.messages=h.c.chatStore.chats[chatId].messages;h.c.chatModelSelector={capture:()=>selection};h.c.intercept=(url,opt)=>request(url,{cookie:user,method:opt.method||'GET',body:opt.body?JSON.parse(opt.body):undefined,signal:opt.signal});await h.c.sendMessage();const after=await history();assert.equal(after.length,before.length+1);assert.equal(after.at(-1).role,'user');assert.equal(h.saves().filter(x=>x.body.role==='assistant').length,0);assert(h.c.chat.querySelectorAll('.completion-notice').some(e=>e.textContent.includes('could not complete')));await mode('complete');
 });
 await t.test('client disconnect and explicit cancellation abort upstream',async()=>{
  for(const how of ['cancel','abort']){await mode('hold');const baseline=events.filter(e=>e.type==='aborted').length,controller=new AbortController();const r=await request('/api/chat',{cookie:user,body:chatBody(),signal:controller.signal}),reader=r.body.getReader();await reader.read();if(how==='cancel')await reader.cancel();else controller.abort();await wait(()=>events.filter(e=>e.type==='aborted').length>baseline);}await mode('complete');
 });
 await t.test('actual frontend cancellation retains partial output once without a success terminal',async()=>{
  await mode('hold');const before=await history(),h=frontend();h.c.intercept=(url,opt)=>request(url,{cookie:user,method:opt.method||'GET',body:opt.body?JSON.parse(opt.body):undefined,signal:opt.signal});h.c.chatStore=await h.c.prepareServerChatStore();h.c.chatStore.activeChatId=chatId;h.c.messages=h.c.chatStore.chats[chatId].messages;h.c.restoreChat();h.c.chatModelSelector={capture:()=>selection};
  const read=h.c.readAssistantStream;h.c.readAssistantStream=(reader,onChunk)=>read(reader,chunk=>{onChunk(chunk);if(chunk.choices?.[0]?.delta?.content)h.c.controller.abort();});await h.c.sendMessage();
  const rows=await history();assert.equal(rows.length,before.length+2);assert.equal(rows.at(-1).content,'First ');assert.equal(h.saves().filter(x=>x.body.role==='assistant').length,0);assert(h.c.chat.querySelectorAll('.completion-notice').some(e=>/Generation stopped.*incomplete/.test(e.textContent)));await mode('complete');
 });
 await t.test('safe rate/model/timeout errors and no automatic retries',async()=>{
  for(const [value,code] of [['rate','DEEPSEEK_RATE'],['model-error','DEEPSEEK_MODEL'],['timeout','DEEPSEEK_TIMEOUT']]){await mode(value);const count=events.filter(e=>e.type==='request').length;const r=await request('/api/chat',{cookie:user,body:chatBody()});const text=await r.text();assert.equal(responseEvents(text)[0].code,code);assert(!text.includes('sensitive fixture'));assert.equal(events.filter(e=>e.type==='request').length,count+1);}await mode('complete');
 });
 await t.test('switching local adapters preserves stored history and selects native routes',async()=>{
  const before=await history();for(const [id,model,expected] of [['llama','local-model','Local fixture'],['ollama','ollama-model','Ollama fixture'],['deepseek','second','First second']]){const h=frontend();h.c.intercept=(url,opt)=>request(url,{cookie:user,method:opt.method||'GET',body:opt.body?JSON.parse(opt.body):undefined,signal:opt.signal});h.c.chatStore=await h.c.prepareServerChatStore();h.c.chatStore.activeChatId=chatId;h.c.messages=h.c.chatStore.chats[chatId].messages;h.c.restoreChat();h.c.chatModelSelector={capture:()=>({providerId:id,model})};await h.c.sendMessage();assert.equal((await history()).at(-1).content,expected);}const rows=await history();assert.deepEqual(rows.slice(0,before.length),before);assert(events.some(e=>e.path==='/v1/chat/completions'));assert(events.some(e=>e.path==='/api/chat'));assert(events.filter(e=>e.type==='request'&&e.path==='/v1/chat/completions').at(-1).body.messages.some(m=>m.role==='assistant'&&m.content==='Ollama fixture'));
 });
 await t.test('disabled gate survives restart and saved selection cannot resolve credentials',async()=>{
  await stop();await start('0');const list=await json('/api/ai/models',{cookie:user});assert(!list.models.some(m=>m.providerId==='deepseek'));assert.deepEqual((await json('/api/settings',{cookie:user})).modelSelection,selection);await json('/api/chat',{cookie:user,body:chatBody()},400);const r=await request('/api/chat',{cookie:user,body:{chatId,expectedRevision:0,messages:[]}});assert.equal(r.status,403);await r.text();assert(!events.some(e=>e.type==='credential'||e.type==='request'||e.type==='dns'));
 });
 await t.test('missing environment secret fails safely without outbound transport',async()=>{
  await stop();await start('1',false);const r=await request('/api/chat',{cookie:user,body:chatBody()});assert.equal(responseEvents(await r.text())[0].code,'DEEPSEEK_AUTH');assert(!events.some(e=>e.type==='request'||e.type==='dns'));assert(events.some(e=>e.type==='credential'));
 });
 await t.test('admin-only aggregates and switch block new attempts without credential reads',async()=>{
  await json('/api/admin/ai/deepseek-usage',{cookie:user},403);await json('/api/admin/ai/deepseek-usage',{},401);
  const limits={enabled:false,max_output_tokens:16,max_concurrent:1,per_hour:100,per_day:1000,estimated_daily_usd:null};
  const summary=await json('/api/admin/ai/deepseek-usage',{cookie:admin,body:limits});assert(summary.today.requests>0);assert(summary.today.completed>0);assert.equal(summary.estimatedCost,null);assert(!JSON.stringify(summary).includes('resp_fixture'));
  const before=events.filter(e=>e.type==='credential').length;await json('/api/chat',{cookie:user,body:chatBody()},403);assert.equal(events.filter(e=>e.type==='credential').length,before);assert(!(await json('/api/ai/models',{cookie:user})).models.some(m=>m.providerId==='deepseek'));
  await json('/api/admin/ai/deepseek-usage',{cookie:admin,body:{...limits,enabled:true}});await stop();await start('1');
 });
 await t.test('HTTP concurrency admission rejects a competing request atomically',async()=>{
  await mode('hold');const r=await request('/api/chat',{cookie:user,body:chatBody()}),reader=r.body.getReader();await reader.read();const count=events.filter(e=>e.type==='request').length;
  assert.equal((await json('/api/admin/ai/deepseek-usage',{cookie:admin})).currentConcurrency,1);const rejected=await json('/api/chat',{cookie:user,body:chatBody()},429);assert.equal(rejected.code,'DEEPSEEK_CONCURRENCY_LIMIT');assert.equal(events.filter(e=>e.type==='request').length,count);await release();while(!(await reader.read()).done){}await mode('complete');
 });
 await t.test('failed, token-limited and transport-interrupted partial text restores explicit statuses',async()=>{
  for(const [mock,status] of [['partial-failed','failed'],['incomplete','incomplete'],['interrupted','interrupted']]){
   await mode(mock);const r=await request('/api/chat',{cookie:user,body:chatBody()});const wire=await r.text();assert(wire.includes('"responseStatus":"'+status+'"'));const rows=await history();assert.equal(rows.at(-1).content,'First ');assert.equal(rows.at(-1).responseStatus,status);
  }await mode('complete');
 });
 await t.test('abrupt fixture process exit reconciles durable partial output on restart',async()=>{
  await mode('hold');const r=await request('/api/chat',{cookie:user,body:chatBody()}),reader=r.body.getReader();await reader.read();const exited=new Promise(resolve=>child.once('exit',resolve));child.send({type:'crash'});assert.equal(await exited,23);child=null;await reader.cancel().catch(()=>{});await start('1');
  const rows=await history();assert.equal(rows.at(-1).content,'First ');assert.equal(rows.at(-1).responseStatus,'interrupted');
  const inspect=new DatabaseSync(file,{readOnly:true});try{const row=inspect.prepare('SELECT * FROM deepseek_usage ORDER BY rowid DESC LIMIT 1').get();assert.equal(row.status,'interrupted');assert.equal(row.output_tokens,null);assert.equal(row.provider_response_id,null);assert(row.finished_at>=row.started_at);}finally{inspect.close();}
  const h=frontend();h.c.intercept=(url,opt)=>request(url,{cookie:user,method:opt.method||'GET',body:opt.body?JSON.parse(opt.body):undefined});h.c.chatStore=await h.c.prepareServerChatStore();h.c.chatStore.activeChatId=chatId;h.c.messages=h.c.chatStore.chats[chatId].messages;h.c.restoreChat();assert(h.c.chat.querySelectorAll('.completion-notice').some(e=>e.textContent.includes('interrupted')));
 });
 await t.test('logs and public responses do not expose credentials; graceful cleanup succeeds',async()=>{
  assert(!log.includes(key));assert(!log.includes(password));assert(!log.includes(user));await stop();const probe=require('node:net').createServer();await new Promise((resolve,reject)=>{probe.once('error',reject);probe.listen(4183,'127.0.0.1',resolve);});await new Promise(r=>probe.close(r));
 });
});
