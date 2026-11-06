'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const {resolveStoragePaths}=require('../core/data-paths');
const {createAttachments}=require('../core/attachments');
const input={name:'note.txt',base64:Buffer.from('fixture').toString('base64')};
async function fixture(t){const root=await fs.mkdtemp(path.join(os.tmpdir(),'attachment-storage-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));return root;}
test('legacy, portable and override attachment locations share storage-mode semantics',()=>{
 assert.equal(resolveStoragePaths('C:\\AI\\chatbot-ui',{platform:'win32',env:{}}).attachments,'C:\\AI\\chatbot-ui\\data\\attachments');
 assert.equal(resolveStoragePaths('/opt/app',{platform:'linux',env:{CHATBOT_STORAGE_MODE:'per-user',CHATBOT_DATA_ROOT:'/portable'}}).attachments,'/portable/data/attachments');
 assert.equal(resolveStoragePaths('/opt/app',{platform:'linux',env:{CHATBOT_STORAGE_MODE:'per-user',CHATBOT_DATA_ROOT:'/portable',CHATBOT_DB_PATH:'/elsewhere/chat.db'}}).attachments,'/portable/data/attachments');
 assert.throws(()=>resolveStoragePaths('/opt/app',{platform:'linux',env:{CHATBOT_HOME:'/one',CHATBOT_DATA_ROOT:'/two'}}));
 assert.throws(()=>createAttachments('relative'));
});
test('resolution and reads create nothing; authorized saves retain UUID markers and ownership',async t=>{
 const root=await fixture(t),selected=resolveStoragePaths(root,{env:{CHATBOT_STORAGE_MODE:'per-user',CHATBOT_DATA_ROOT:root}}).attachments,a=createAttachments(selected);
 assert.deepEqual(await fs.readdir(root),[]);
 await assert.rejects(a.get('u',crypto.randomUUID()),/Attachment unavailable/);
 assert.deepEqual(await fs.readdir(root),[]);
 const r=await a.save('u',input);assert.match(r.id,/^[a-f0-9-]{36}$/);
 assert.equal((await a.get('u',r.id)).text,'fixture');await assert.rejects(a.get('other',r.id));
 assert.match((await a.expand('u',[{role:'user',content:'[Chatbot attachment: '+r.id+']'}],false))[0].content,/fixture/);
 await assert.rejects(a.save('u',{...input,name:'../escape.txt'}));await assert.rejects(a.remove('u','../escape'));
 await a.remove('u',r.id);await assert.rejects(a.get('u',r.id));
});
test('portable missing attachment never falls back to legacy storage',async t=>{
 const root=await fixture(t),legacy=createAttachments(path.join(root,'legacy')),portable=createAttachments(path.join(root,'portable'));
 const r=await legacy.save('u',input);await assert.rejects(portable.get('u',r.id));await assert.rejects(portable.remove('u',r.id));assert.equal((await legacy.get('u',r.id)).text,'fixture');
});
for(const position of ['root','owner'])test('rejects directory symlink/junction escape at '+position,async t=>{
 const root=await fixture(t),outside=path.join(root,'outside'),storage=path.join(root,'storage');await fs.mkdir(outside);await fs.mkdir(storage);
 const id=crypto.randomUUID(),target=path.join(outside,id);await fs.writeFile(target,JSON.stringify({id,...input,text:'outside'}));
 const link=position==='root'?path.join(root,'linked'):path.join(storage,crypto.createHash('sha256').update('u').digest('hex'));
 await fs.symlink(outside,link,process.platform==='win32'?'junction':'dir');
 try{const a=createAttachments(position==='root'?link:storage);await assert.rejects(a.get('u',id));await assert.rejects(a.remove('u',id));await assert.rejects(a.save('u',input));assert.equal(JSON.parse(await fs.readFile(target,'utf8')).text,'outside');assert.deepEqual(await fs.readdir(outside),[id]);}
 finally{await fs.unlink(link);}
});
