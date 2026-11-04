'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),{Readable}=require('node:stream'),{DatabaseSync}=require('node:sqlite');
const {handle}=require('../core/deepseek-admin');
const {createSystemLogService}=require('../core/system-logs');
function fixture(t){const db=new DatabaseSync(':memory:');require('../core/database-schema').initializeSchema(db);t.after(()=>db.close());const usage=require('../core/openai-usage').forProvider('deepseek');usage.configure(db,{enabled:true,max_output_tokens:128,max_concurrent:1,per_hour:3,per_day:3,estimated_daily_usd:null});
 const c={id:'ds',adapter:'deepseek-chat',endpoint:'https://api.deepseek.com',credentialRef:'protected:ds',model:'deepseek-chat',parameters:['max_tokens'],models:[{id:'deepseek-chat',name:'Chat',enabled:true,chat:true,parameters:['max_tokens'],defaults:{}}],capabilities:{streaming:true},enabled:false};let key=null,user={id:'admin',is_admin:1},calls=0;
 const credentials={configured:async()=>!!key,save:async(c,value,authorized)=>{assert(authorized());key=value;},remove:async()=>{key=null;}},connections={read:async()=>({connections:[c]})};
 async function request(action,method='GET',body={},override={}){let status,output;const req=Readable.from(method==='POST'?[JSON.stringify(body)]:[]);Object.assign(req,{url:'/api/admin/ai/connections/ds/'+action,method,headers:{origin:'http://127.0.0.1:4183',host:'127.0.0.1:4183','x-chatbot-action':'configure-connections'}});const res={writeHead:s=>status=s,end:s=>output=JSON.parse(s)};await handle({req,res,db,connections,credentials,authenticate:()=>user,providers:{chat:async(c,input,options)=>{calls++;assert.equal(input.max_tokens,16);assert.equal(options.maxOutputTokens,16);options.beforeSend();options.onProgress({status:'completed',usage:{promptTokens:2,generatedTokens:1}});return new Response('data: [DONE]\n\n');}},...override});return {status,output};}
 return {request,setUser:v=>user=v,calls:()=>calls,db};}
test('credential endpoints reject anonymous, regular and expired sessions',async t=>{const f=fixture(t);for(const [user,status] of [[null,401],[{id:'u',is_admin:0},403]]){f.setUser(user);assert.equal((await f.request('credential','POST',{apiKey:'synthetic'})).status,status);}let count=0;assert.equal((await f.request('credential','POST',{apiKey:'synthetic'},{authenticate:()=>++count===1?{id:'a',is_admin:1}:null})).status,401);assert.equal(f.calls(),0);});
test('credential save/status/replace/delete returns no secret',async t=>{const f=fixture(t);for(const value of ['synthetic-one','synthetic-two']){const r=await f.request('credential','POST',{apiKey:value});assert.deepEqual(r.output,{configured:true});assert(!JSON.stringify(r).includes(value));}assert.deepEqual((await f.request('credential')).output,{configured:true});assert.deepEqual((await f.request('credential','DELETE')).output,{configured:false});});
test('paid test requires explicit confirmation, credential, caps and durable usage',async t=>{const f=fixture(t);assert.equal((await f.request('test','POST',{confirmPaidTest:true})).status,400);await f.request('credential','POST',{apiKey:'synthetic'});assert.equal((await f.request('test','POST')).status,400);assert.equal(f.calls(),0);const result=await f.request('test','POST',{confirmPaidTest:true});assert.equal(result.output.success,true);assert.equal(result.output.model,'deepseek-chat');assert.equal(f.calls(),1);assert.equal(f.db.prepare('SELECT output_tokens FROM deepseek_usage').get().output_tokens,1);assert.equal(f.db.prepare('SELECT count(*) n FROM messages').get().n,0);});
test('system-log database failures do not interrupt a successful provider test',async t=>{
 const f=fixture(t);await f.request('credential','POST',{apiKey:'synthetic'});
 const logs=createSystemLogService({db:f.db});t.after(()=>logs.stop());
 f.db.exec("CREATE TRIGGER reject_system_log BEFORE INSERT ON system_events BEGIN SELECT RAISE(ABORT, 'fixture logging failure'); END");
 const result=await f.request('test','POST',{confirmPaidTest:true},{log:(code,fields)=>logs.log(code,fields)});
 await logs.flush();
 assert.equal(result.status,200);assert.equal(result.output.success,true);assert.equal(f.calls(),1);
 assert.ok(logs.getStats().failures>=2);
});
test('test failures return sanitized errors and close usage reservation',async t=>{const f=fixture(t);await f.request('credential','POST',{apiKey:'synthetic'});const result=await f.request('test','POST',{confirmPaidTest:true},{providers:{chat:async()=>{throw Error('private credential header');}}});assert.equal(result.status,400);assert(!JSON.stringify(result).includes('private'));assert.equal(f.db.prepare('SELECT status FROM deepseek_usage').get().status,'failed');});

test('cross-origin credential writes and unconfirmed paid tests cannot dispatch',async t=>{
 const f=fixture(t),req=Readable.from([JSON.stringify({apiKey:'synthetic'})]);Object.assign(req,{url:'/api/admin/ai/connections/ds/credential',method:'POST',headers:{origin:'https://unrelated.example',host:'127.0.0.1:4183','x-chatbot-action':'configure-connections'}});let status;
 await handle({req,res:{writeHead:s=>status=s,end:()=>{}},db:f.db,authenticate:()=>({id:'a',is_admin:1}),connections:{read:()=>{throw Error('Must not read');}}});assert.equal(status,403);assert.equal(f.calls(),0);
});
