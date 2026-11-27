'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {DatabaseSync}=require('node:sqlite');
const {createCanvas}=require('@napi-rs/canvas');
const {createImages,bind}=require('../core/image-attachments');
const {decode}=require('../core/image-codec');
const canvas=createCanvas(4,3);canvas.getContext('2d').fillRect(0,0,4,3);
const png=canvas.toBuffer('image/png');
function fixture(t,options={}){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'chatbot-image-test-'));const db=new DatabaseSync(':memory:');require('../core/database-schema').initializeSchema(db);
 db.exec("INSERT INTO users VALUES('u','user','synthetic',0); INSERT INTO users VALUES('v','other','synthetic',0); INSERT INTO chats(id,title,user_id) VALUES('c','fixture','u'); INSERT INTO chats(id,title,user_id) VALUES('d','fixture','v');");
 t.after(()=>{db.close();if(!root.startsWith(path.join(os.tmpdir(),'chatbot-image-test-')))throw Error('Cleanup path');fs.rmSync(root,{recursive:true,force:true});});
 const storage=require('../core/attachments').createAttachments(root),store=createImages(db,{storage,...options});
 return {db,store,storage,upload:()=>store.save('u',{chatId:'c',name:'test.png',base64:png.toString('base64')})};
}
test('native PNG JPEG WebP decode and re-encode, corruption and limits rejected',async()=>{
 for(const format of ['png','jpeg','webp']){const bytes=await canvas.encode(format);const r=await decode(bytes,10485760);assert.equal(r.width,4);assert.equal(r.height,3);assert.equal(r.bytes.toString('ascii',1,4),'PNG');}
 for(const b of [Buffer.from('<svg/>'),png.subarray(0,24),Buffer.alloc(100)])await assert.rejects(async()=>decode(b,10485760));
 await assert.rejects(async()=>decode(png,1));const huge=Buffer.from(png);huge.writeUInt32BE(9000,16);await assert.rejects(async()=>decode(huge,10485760));
});
test('owner/chat checks, binding rollback, one image, bound deletion and restoration',async t=>{
 const {db,store,upload}=fixture(t);const a=await upload();assert.equal((await store.get('u',a.id)).mime,'image/png');await assert.rejects(store.get('v',a.id));
 const content='Describe\n[Chatbot image: '+a.id+']';db.exec('BEGIN IMMEDIATE');const id=db.prepare("INSERT INTO messages(chat_id,role,content) VALUES('c','user',?)").run(content).lastInsertRowid;bind(db,'u','c',id,'user',content);db.exec('ROLLBACK');assert.equal(db.prepare('SELECT state FROM image_attachments').get().state,'pending');
 db.exec('BEGIN IMMEDIATE');const mid=db.prepare("INSERT INTO messages(chat_id,role,content) VALUES('c','user',?)").run(content).lastInsertRowid;bind(db,'u','c',mid,'user',content);db.exec('COMMIT');await assert.rejects(store.remove('u',a.id));
 assert.throws(()=>bind(db,'u','c',mid,'user',content+'\n'+content));
 const expanded=await store.expand('u','c',[{role:'user',content}]);assert(expanded[0].content[1].image_url.url.startsWith('data:image/png;base64,'));assert.equal(db.prepare('SELECT content FROM messages').get().content,content);
 await assert.rejects(store.expand('v','c',[{role:'user',content}]));await assert.rejects(store.expand('u','d',[{role:'user',content}]));
 db.prepare('DELETE FROM chats WHERE id=?').run('c');await store.cleanup();assert.equal(db.prepare('SELECT COUNT(*) n FROM image_attachments').get().n,0);await assert.rejects(store.get('u',a.id));
});
test('quotas reserve before decode, expired uploads cleaned, failed deletion retried',async t=>{
 let now=1000;const f=fixture(t,{policy:{max:100000,quota:100000,count:1},now:()=>now});const first=await f.upload();await assert.rejects(f.upload());
 const original=f.storage.purge;let fail=true;f.storage.purge=async(...args)=>{if(fail)throw Error('locked');return original(...args);};now+=3600001;await f.store.cleanup();assert.equal(f.db.prepare('SELECT state FROM image_attachments').get().state,'deleting');fail=false;await f.store.cleanup();assert.equal(f.db.prepare('SELECT COUNT(*) n FROM image_attachments').get().n,0);await assert.rejects(f.store.get('u',first.id));
});
test('interrupted/unauthorized upload cannot bind and leaves no usable file',async t=>{
 const f=fixture(t,{decode:async()=>{throw Error('decoder failed');}});await assert.rejects(f.upload());assert.equal(f.db.prepare('SELECT COUNT(*) n FROM image_attachments').get().n,0);
 await assert.rejects(f.store.save('u',{chatId:'d',name:'test.png',base64:png.toString('base64')}));
});
test('schema additive and idempotent; text unchanged',t=>{
 const {db}=fixture(t);db.exec("INSERT INTO messages(chat_id,role,content) VALUES('c','user','unchanged')");require('../core/database-schema').initializeSchema(db);assert.equal(db.prepare('SELECT content FROM messages').get().content,'unchanged');assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');bind(db,'u','c',1,'user','normal text');
});
test('vision authorization rejects unsupported model and leaves configured flags unchanged',async()=>{
 const {authorizeVision}=require('../core/image-routes');const c={id:'p',name:'p',adapter:'ollama',model:'m',parameters:[],enabled:true,capabilities:{streaming:true,vision:false},credentialRef:null};const connections={read:async()=>({revision:1,defaultId:'p',connections:[c]})};
 await assert.rejects(authorizeVision(connections,{capabilities:async()=>({capabilities:{vision:{state:'unknown'}}})},null));const p=await authorizeVision(connections,{capabilities:async()=>({capabilities:{vision:{state:'verified'}}})},null);assert(p.capabilities.vision);assert.equal(c.capabilities.vision,false);
});
test('native Ollama image payload and streaming are preserved',async()=>{
 const c={id:'p',name:'p',adapter:'ollama',model:'m',endpoint:'http://127.0.0.1:9999/v1',credentialRef:null,parameters:[],enabled:true,capabilities:{streaming:true,vision:true}};
 const a=require('../core/provider-adapter').createAdapter({secret:async()=>null,fetchImpl:async(url,o)=>{if(url.endsWith('/api/ps'))return Response.json({models:[]});assert(url.endsWith('/api/chat'));const b=JSON.parse(o.body);assert.deepEqual(b.messages[0].images,[png.toString('base64')]);return new Response(JSON.stringify({message:{content:'fixture answer'},done:true})+'\n');}});
 const r=await a.chat(c,{messages:[{role:'user',content:[{type:'text',text:'describe'},{type:'image_url',image_url:{url:'data:image/png;base64,'+png.toString('base64')}}]}]});assert((await r.text()).includes('fixture answer'));
});
test('quota admission is concurrent-safe and cleanup cannot bind deleting rows',async t=>{
 let release,entered;const ready=new Promise(r=>entered=r);const f=fixture(t,{policy:{max:100000,quota:100000,count:1},decode:async()=>{entered();await new Promise(r=>release=r);return {bytes:png,width:4,height:3};}});
 const first=f.upload();await ready;await assert.rejects(f.upload());release();const a=await first;await f.store.remove('u',a.id);assert.throws(()=>bind(f.db,'u','c',1,'user','[Chatbot image: '+a.id+']'));
});
test('real message insertion binds atomically and rolls back invalid references',t=>{
 const {db}=fixture(t);const vm=require('node:vm');const context={module:{exports:{}},__dirname:'/isolated',require:n=>n==='./core/database-startup'?{databasePath:()=>':memory:',openExistingDatabase:()=>db}:n==='./auth'?{}:n==='./core/image-attachments'?require('../core/image-attachments'):require(n)};
 vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../db.js'),'utf8'),context);
 assert.throws(()=>context.module.exports.createMessage('c','user','[Chatbot image: 11111111-1111-1111-1111-111111111111]',null,'u',null,0));assert.equal(db.prepare('SELECT COUNT(*) n FROM messages').get().n,0);
 context.module.exports.createMessage('c','user','plain text',null,'u',null,0);assert.equal(db.prepare('SELECT COUNT(*) n FROM messages').get().n,1);
});
test('legacy attachment endpoint cannot bypass bound image deletion',async()=>{
 const {handle}=require('../core/extension-routes');const res={writeHead(n){this.status=n;},end(){}};
 await handle({url:'/api/attachments/11111111-1111-1111-1111-111111111111',method:'DELETE'},res,{user:{id:'u'},revalidate:()=>true,imageManaged:()=>true});assert.equal(res.status,400);
});
test('image preview removal and restoration remain reference-only',()=>{
 const source=fs.readFileSync(path.join(__dirname,'../public/app.js'),'utf8');assert(source.includes('URL.revokeObjectURL(previewUrl)'));assert(source.includes("thumbnail.src='/api/images/'+refs[0][1]"));assert(source.includes("if (isImage && !globalThis.chatCapabilities?.imageAllowed())"));assert(!source.includes('console.log("Attachment ready:"'));
});
test('authenticated image HTTP handler uploads and retrieves, denies other users and stale session',async t=>{
 const {store}=fixture(t),{handle}=require('../core/image-routes');const response=()=>({writeHead(n,h){this.status=n;this.headers=h;},end(body){this.body=body;}});
 const req={method:'POST',url:'/api/images',headers:{host:'localhost','origin':'http://localhost','x-chatbot-action':'extensions'},async *[Symbol.asyncIterator](){yield JSON.stringify({name:'test.png',chatId:'c',base64:png.toString('base64'),selection:{providerId:'p',model:'m'}});}};
 const res=response();let checked=false;await handle(req,res,{user:{id:'u'},authorize:()=>true,images:store,vision:async()=>{checked=true;}});assert.equal(res.status,201);assert(checked);const id=JSON.parse(res.body).id;
 for(const user of ['u','v']){const r=response();await handle({method:'GET',url:'/api/images/'+id},r,{user:{id:user},authorize:()=>true,images:store});assert.equal(r.status,user==='u'?200:400);if(user==='u')assert.equal(r.headers['Content-Type'],'image/png');}
 const stale=response();await handle({method:'GET',url:'/api/images/'+id},stale,{user:{id:'u'},authorize:()=>false,images:store});assert.equal(stale.status,400);
 const anonymous=response();await handle(req,anonymous,{user:null});assert.equal(anonymous.status,401);
});
