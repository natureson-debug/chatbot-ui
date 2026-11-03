'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),{DatabaseSync}=require('node:sqlite'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),vm=require('node:vm');
const {initializeSchema}=require('../core/database-schema'),usage=require('../core/openai-usage').forProvider('deepseek');
const defaults={enabled:true,max_output_tokens:32,max_concurrent:1,per_hour:2,per_day:3,estimated_daily_usd:null};
const request={provider:{id:'deepseek',model:'approved',parameters:['max_tokens']},userId:'u',chatId:'chat',revision:0,authorize:()=>true};
const original=process.env.CHATBOT_DEEPSEEK_ENABLED;
test.beforeEach(()=>process.env.CHATBOT_DEEPSEEK_ENABLED='1');test.after(()=>{if(original===undefined)delete process.env.CHATBOT_DEEPSEEK_ENABLED;else process.env.CHATBOT_DEEPSEEK_ENABLED=original;});
function fixture(t,file=':memory:'){const db=new DatabaseSync(file);t.after(()=>db.close());initializeSchema(db);db.exec("INSERT INTO users VALUES('u','synthetic','unused',0);INSERT INTO chats(id,title,user_id) VALUES('chat','Fixture','u')");usage.configure(db,defaults);return db;}
test('completed usage/status persist separately from text and terminal calls deduplicate',t=>{
 const db=fixture(t),a=usage.admit(db,{...request,now:100});usage.observe(db,a.id,{text:'partial'},101);assert.equal(db.prepare('SELECT response_status FROM messages').get().response_status,'in_progress');
 usage.observe(db,a.id,{status:'completed',usage:{promptTokens:10,generatedTokens:3,cachedTokens:0},providerResponseId:'resp_fixture'},200);usage.observe(db,a.id,{status:'failed',text:'duplicate'},300);
 const row=db.prepare('SELECT * FROM deepseek_usage').get();assert.equal(row.status,'completed');assert.equal(row.latency_ms,100);assert.equal(row.cached_input_tokens,0);assert.equal(row.provider_response_id,'resp_fixture');assert.equal(db.prepare('SELECT COUNT(*) n FROM deepseek_usage').get().n,1);assert.equal(db.prepare('SELECT content FROM messages').get().content,'partial');assert(!db.prepare('SELECT telemetry_json FROM messages').get().telemetry_json.includes('resp_fixture'));
});
test('terminal statuses are durable and absent/invalid usage never becomes zero',t=>{
 const db=fixture(t);usage.configure(db,{...defaults,per_hour:100,per_day:100});for(const status of ['completed','cancelled','failed','incomplete','interrupted']){const a=usage.admit(db,request);usage.observe(db,a.id,{text:status});usage.observe(db,a.id,{status,usage:{promptTokens:-1,generatedTokens:'0'}});const row=db.prepare('SELECT * FROM deepseek_usage WHERE request_id=?').get(a.id);assert.equal(row.status,status);assert.equal(row.output_tokens,null);assert.equal(row.input_tokens,null);}
});
test('gates, ownership, revision and session reject before admission',t=>{
 const db=fixture(t);for(const changes of [{userId:'other'},{revision:1},{chatId:undefined},{authorize:()=>false}])assert.throws(()=>usage.admit(db,{...request,...changes}));
 usage.configure(db,{...defaults,enabled:false});assert.throws(()=>usage.admit(db,request),/DISABLED/);usage.configure(db,defaults);process.env.CHATBOT_DEEPSEEK_ENABLED='0';assert.throws(()=>usage.admit(db,request),/DISABLED/);assert.equal(db.prepare('SELECT count(*) n FROM deepseek_usage').get().n,0);
});
test('durable concurrency slots shared across two SQLite connections',t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'deepseek-limits-')),file=path.join(root,'db.sqlite');const db=new DatabaseSync(file),other=new DatabaseSync(file);t.after(()=>{other.close();db.close();fs.rmSync(root,{recursive:true,force:true});});initializeSchema(db);db.exec("INSERT INTO users VALUES('u','synthetic','unused',0);INSERT INTO chats(id,title,user_id) VALUES('chat','Fixture','u')");usage.configure(db,defaults);
 const a=usage.admit(db,request);assert.throws(()=>usage.admit(other,request),/CONCURRENCY/);usage.observe(db,a.id,{status:'failed'});assert(usage.admit(other,request).id);
});
test('rolling hourly/day limits count failures and permit fresh windows',t=>{
 const db=fixture(t),base=100000000;for(let i=0;i<2;i++){const a=usage.admit(db,{...request,now:base+i});usage.observe(db,a.id,{status:'failed'},base+i+1);}assert.throws(()=>usage.admit(db,{...request,now:base+5}),/HOURLY/);
 const a=usage.admit(db,{...request,now:base+3600002});usage.observe(db,a.id,{status:'cancelled'},base+3600003);assert.throws(()=>usage.admit(db,{...request,now:base+3600004}),/DAILY/);assert(usage.admit(db,{...request,now:base+86400010}).id);
});
test('unknown pricing is not free: monetary threshold blocks admission',t=>{
 const db=fixture(t);usage.configure(db,{...defaults,estimated_daily_usd:1});assert.throws(()=>usage.admit(db,request),/COST_UNVERIFIABLE/);assert.equal(usage.summary(db).estimatedCost,null);assert.equal(usage.summary(db).costStatus,'unavailable');
});
test('restart reconciliation marks unfinished records/messages interrupted idempotently',t=>{
 const db=fixture(t),a=usage.admit(db,{...request,now:100});usage.observe(db,a.id,{text:'saved before crash'});assert.equal(usage.reconcile(db,300),1);assert.equal(usage.reconcile(db,400),0);assert.equal(db.prepare('SELECT status FROM deepseek_usage').get().status,'interrupted');assert.equal(db.prepare('SELECT response_status FROM messages').get().response_status,'interrupted');assert.equal(db.prepare('SELECT content FROM messages').get().content,'saved before crash');
});
test('clear/delete cannot be undone by late server output',t=>{
 const db=fixture(t),a=usage.admit(db,request);usage.observe(db,a.id,{text:'before clear'});db.exec("DELETE FROM messages;UPDATE chats SET revision=1 WHERE id='chat'");usage.observe(db,a.id,{text:'late',status:'completed'});assert.equal(db.prepare('SELECT count(*) n FROM messages').get().n,0);
 const b=usage.admit(db,{...request,revision:1});db.exec("DELETE FROM chats WHERE id='chat'");usage.observe(db,b.id,{text:'late',status:'completed'});assert.equal(db.prepare('SELECT count(*) n FROM messages').get().n,0);
});
function oldSchema(){const source=fs.readFileSync(path.join(__dirname,'../core/database-schema.js'),'utf8').replace(/ \/\/ Additive OpenAI[\s\S]*? db.exec\('COMMIT'\);/," db.exec('COMMIT');");const ctx={module:{exports:{}}};vm.runInNewContext(source,ctx);return ctx.module.exports.initializeSchema;}
test('additive migration preserves legacy rows and older initializer can reopen it',t=>{
 const db=new DatabaseSync(':memory:');t.after(()=>db.close());oldSchema()(db);db.exec("INSERT INTO users VALUES('u','user','unused',0);INSERT INTO chats(id,title,user_id) VALUES('c','old','u');INSERT INTO messages(chat_id,role,content) VALUES('c','assistant','legacy')");initializeSchema(db);initializeSchema(db);oldSchema()(db);const row=db.prepare('SELECT * FROM messages').get();assert.equal(row.content,'legacy');assert.equal(row.response_status,null);assert.equal(usage.settings(db).enabled,0);
});
test('migration failure rolls back additive schema changes',t=>{
 const db=new DatabaseSync(':memory:');t.after(()=>db.close());oldSchema()(db);const originalExec=db.exec.bind(db);db.exec=sql=>{if(sql.includes('CREATE UNIQUE INDEX IF NOT EXISTS message_response_request'))throw Error('injected migration failure');return originalExec(sql);};assert.throws(()=>initializeSchema(db),/injected/);assert(!db.prepare('PRAGMA table_info(messages)').all().some(c=>c.name==='response_status'));assert(!db.isTransaction);
});
test('invalid safeguards cannot change accepted configuration',t=>{
 const db=fixture(t),before=usage.settings(db);for(const change of [{max_concurrent:0},{per_hour:-1},{max_output_tokens:Infinity},{estimated_daily_usd:-1},{enabled:'true'},{unknown:'private'}])assert.throws(()=>usage.configure(db,{...defaults,...change}));assert.deepEqual(usage.settings(db),before);
});
test('models without approved output-limit support cannot bypass the cap',t=>{
 const db=fixture(t);assert.throws(()=>usage.admit(db,{...request,provider:{...request.provider,parameters:[]}}),/OUTPUT_LIMIT_UNSUPPORTED/);assert.equal(db.prepare('SELECT count(*) n FROM deepseek_usage').get().n,0);
});

test('DeepSeek and OpenAI switches, slots and usage are independent',t=>{
 const db=fixture(t),openai=require('../core/openai-usage');
 assert.equal(openai.settings(db).enabled,0);
 const a=usage.admit(db,request);assert.equal(usage.summary(db).currentConcurrency,1);assert.equal(openai.summary(db).currentConcurrency,0);
 openai.configure(db,{...defaults,enabled:true});usage.configure(db,{...defaults,enabled:false});
 assert.equal(openai.settings(db).enabled,1);assert.throws(()=>usage.admit(db,request),/DISABLED/);
 usage.observe(db,a.id,{status:'completed',usage:{promptTokens:2,generatedTokens:1}});
 assert.equal(openai.summary(db).today.requests,0);assert.equal(usage.summary(db).today.requests,1);
});

test('DeepSeek schema migration preserves prior OpenAI records and rolls back on failure',t=>{
 const db=new DatabaseSync(':memory:');t.after(()=>db.close());initializeSchema(db);
 db.exec("INSERT INTO openai_usage(request_id,provider_id,model_id,user_id,conversation_id,revision,started_at,status) VALUES('prior','openai','model','user','chat',0,0,'completed');DROP TABLE deepseek_usage;DROP TABLE deepseek_safeguards;");
 const original=db.exec.bind(db);db.exec=sql=>{if(sql.includes('CREATE TABLE IF NOT EXISTS deepseek_safeguards'))throw Error('injected DeepSeek failure');return original(sql);};
 assert.throws(()=>initializeSchema(db),/injected DeepSeek failure/);assert(!db.isTransaction);assert.equal(db.prepare('SELECT status FROM openai_usage').get().status,'completed');
 db.exec=original;initializeSchema(db);assert.equal(usage.settings(db).enabled,0);assert.equal(db.prepare('SELECT status FROM openai_usage').get().status,'completed');
});
