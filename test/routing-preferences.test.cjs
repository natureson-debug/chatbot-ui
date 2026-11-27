'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{DatabaseSync}=require('node:sqlite'),{Readable}=require('node:stream');
const schema=require('../core/database-schema'),prefs=require('../core/routing-preferences');
const catalog=[{providerId:'p',model:'one'},{providerId:'p',model:'two'}];
function fixture(t){const db=new DatabaseSync(':memory:');schema.initializeSchema(db);db.exec("INSERT INTO users VALUES('a','A','synthetic',0),('b','B','synthetic',0)");t.after(()=>db.close());return db;}
test('defaults disabled; own preferences roundtrip with order and policies; other settings preserved',t=>{
 const db=fixture(t);assert.equal(prefs.load(db,'a',catalog).enabled,false);const v=prefs.defaults();v.enabled=true;v.priorities.vision=[catalog[1],catalog[0]];v.postTask='keep-specialized';v.fallback='never';
 db.prepare("INSERT INTO user_settings(user_id,system_prompt) VALUES('a','keep')").run();prefs.save(db,'a',v,catalog);assert.deepEqual(prefs.load(db,'a',catalog),v);assert.equal(prefs.load(db,'b',catalog).enabled,false);assert.equal(db.prepare("SELECT system_prompt FROM user_settings WHERE user_id='a'").get().system_prompt,'keep');
 schema.initializeSchema(db);assert.deepEqual(prefs.load(db,'a',catalog),v);assert.deepEqual(prefs.load(db,'a',[catalog[0]]).priorities.vision,[catalog[0]]);
});
test('invalid policies, forged models, duplicate identities and permission fields rejected',()=>{
 for(const patch of [{fallback:'force'},{postTask:'other'},{paidApproved:true},{enabled:'true'},{priorities:{...prefs.defaults().priorities,text:[{providerId:'private',model:'x'}]}},{priorities:{...prefs.defaults().priorities,text:[catalog[0],catalog[0]]}}])assert.throws(()=>prefs.validate({...prefs.defaults(),...patch},catalog));
});
test('actual authenticated endpoint ownership, missing and revoked sessions and CSRF',async t=>{
 const db=fixture(t);async function call(user,method,body,authenticate=()=>user,origin='http://localhost'){
  const req=Readable.from(body?[JSON.stringify(body)]:[]);Object.assign(req,{method,headers:{host:'localhost',origin,'x-chatbot-action':'routing-preferences'}});const res={writeHead(n){this.status=n;},end(s){this.body=JSON.parse(s);}};
  await prefs.handle(req,res,{db,user,authenticate,catalog:async()=>catalog});return res;
 }
 const v=prefs.defaults();v.enabled=true;assert.equal((await call({id:'a'},'POST',v)).status,200);assert.equal((await call({id:'b'},'GET')).body.preferences.enabled,false);assert.equal((await call(null,'GET')).status,401);assert.equal((await call({id:'a'},'POST',v,()=>null)).status,401);assert.equal((await call({id:'a'},'POST',v,()=>({id:'a'}),'https://evil.invalid')).status,403);
 assert.equal((await call({id:'a'},'POST',{...v,userId:'b'})).status,400);assert.equal((await call({id:'a'},'GET')).body.active,false);
});
test('additive migration rolls back atomically and legacy writes preserve new column',t=>{
 const db=fixture(t);db.exec('ALTER TABLE user_settings DROP COLUMN routing_preferences');db.exec("INSERT INTO user_settings(user_id,system_prompt) VALUES('a','preserve')");const proxy={exec(sql){if(sql.includes('CREATE TABLE IF NOT EXISTS image_attachments'))throw Error('injected migration failure');return db.exec(sql);},prepare:sql=>db.prepare(sql),get isTransaction(){return db.isTransaction;}};
 assert.throws(()=>schema.initializeSchema(proxy));assert(!db.prepare('PRAGMA table_info(user_settings)').all().some(c=>c.name==='routing_preferences'));assert.equal(db.prepare('SELECT system_prompt FROM user_settings').get().system_prompt,'preserve');schema.initializeSchema(db);prefs.save(db,'a',prefs.defaults(),catalog);db.exec("UPDATE user_settings SET temperature=0.2 WHERE user_id='a'");assert.equal(prefs.load(db,'a',catalog).enabled,false);assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');
});
test('frontend has explicit inactive notice, reorder controls and session reset; no inference wiring',()=>{
 const fs=require('fs'),ui=fs.readFileSync('public/routing-preferences.js','utf8');assert(ui.includes('Only image requests support automatic routing'));assert(ui.includes("['Up',-1]"));assert(ui.includes("['Down',1]"));assert(ui.includes('chatRoutingPreferences={reset'));assert(!ui.includes('/api/chat'));assert(!ui.includes('localStorage'));assert(ui.includes('ChatbotNotifications'));
});
