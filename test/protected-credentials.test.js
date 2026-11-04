'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {createStore}=require('../core/protected-credentials');
const c={id:'ds',adapter:'deepseek-chat',credentialRef:'protected:ds',endpoint:'https://api.deepseek.com'};
// A test-only authenticated cipher exercises file boundaries; real DPAPI is qualified separately.
function cipher(){const key=crypto.randomBytes(32);return async(op,data,entropy)=>{if(op==='protect'){const iv=crypto.randomBytes(12),x=crypto.createCipheriv('aes-256-gcm',key,iv);x.setAAD(Buffer.from(entropy));const out=Buffer.concat([x.update(data),x.final()]);return Buffer.concat([iv,x.getAuthTag(),out]);}const x=crypto.createDecipheriv('aes-256-gcm',key,data.subarray(0,12));x.setAAD(Buffer.from(entropy));x.setAuthTag(data.subarray(12,28));return Buffer.concat([x.update(data.subarray(28)),x.final()]);};}
test('protected credential replacement, restart, binding and deletion never store plaintext',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'chatbot-secret-test-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));const crypt=cipher(),store=createStore(root,crypt);
 assert.equal(await store.configured(c),false);await store.save(c,'synthetic-one');assert.equal(await createStore(root,crypt).read(c),'synthetic-one');assert(!(await fs.readFile(path.join(root,'ds.dpapi'))).includes(Buffer.from('synthetic-one')));
 await store.save(c,'synthetic-two');assert.equal(await store.read(c),'synthetic-two');assert.equal(await store.configured({...c,endpoint:'https://other.example'}),false);
 await assert.rejects(()=>store.save(c,'do-not-save',()=>false));assert.equal(await store.read(c),'synthetic-two');await store.remove(c);assert.equal(await store.configured(c),false);
});
test('protected store rejects path traversal, unsafe references and malformed secrets',async()=>{
 const store=createStore('unused',cipher());for(const invalid of [{...c,id:'../bad'},{...c,adapter:'openai-responses'},{...c,credentialRef:'protected:other'}])await assert.rejects(()=>store.save(invalid,'synthetic'));
 for(const key of ['', 'a\nb', 'a'.repeat(4097)])await assert.rejects(()=>store.save(c,key));
});
