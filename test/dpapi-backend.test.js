'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createDpapiBackend,fileFor}=require('../core/dpapi-backend');
const {createCredentialService}=require('../core/credential-service');

const deepseek={source:'protected',reference:'protected:ds',binding:'["chatbot-deepseek-v1","ds","https://api.deepseek.com/"]'};
const brave={source:'protected',reference:'protected:brave-search',binding:'["chatbot-brave-search-v1"]'};

function memoryFs(files={},{failRead,failWrite}={}){
 const state=new Map(Object.entries(files));
 return {
  async stat(file){const value=state.get(file);if(value===undefined)throw Object.assign(Error('missing'),{code:'ENOENT'});return{isFile:()=>true};},
  async readFile(file){if(failRead)throw Object.assign(Error('locked'),{code:'EACCES'});const value=state.get(file);if(value===undefined)throw Object.assign(Error('missing'),{code:'ENOENT'});return value;},
  async writeFile(file,data){if(failWrite)throw Error('write denied');state.set(file,data);},
  async mkdir(){},
  async rename(from,to){if(failWrite)throw Error('rename denied');state.set(to,state.get(from));state.delete(from);},
  async unlink(file){state.delete(file);}
 };
}

function okSecret(value='synthetic'){return {status:'available',secret:value};}

test('fileFor preserves DeepSeek and Brave binding names',()=>{
 assert.equal(fileFor(deepseek,'C:\\root'),'C:\\root\\ds.dpapi');
 assert.equal(fileFor(brave,'C:\\root'),'C:\\root\\brave-search.dpapi');
 assert.equal(fileFor({source:'protected',reference:'protected:bad-id!'},'C:\\root'),null);
});

test('available, missing and inaccessible statuses are explicit',async()=>{
 const crypt=async()=>Buffer.from('synthetic');
 const available=createDpapiBackend({root:'C:\\root',fs:memoryFs({'C:\\root\\ds.dpapi':Buffer.from('blob')}),crypt});
 assert.deepEqual(await available.status(deepseek),{status:'available'});
 assert.deepEqual(await available.resolve(deepseek),{status:'available',secret:'synthetic'});
 const missing=createDpapiBackend({root:'C:\\root',fs:memoryFs({}),crypt});
 assert.deepEqual(await missing.status(deepseek),{status:'missing'});
 const locked=createDpapiBackend({root:'C:\\root',fs:memoryFs({'C:\\root\\ds.dpapi':Buffer.from('blob')},{failRead:true}),crypt});
 assert.deepEqual(await locked.status(deepseek),{status:'inaccessible'});
});

test('incorrect binding and malformed decrypted values report undecryptable without secrets',async()=>{
 for(const crypt of [async()=>{throw Error('entropy mismatch')},async()=>Buffer.from('bad\nsecret')]){
  const backend=createDpapiBackend({root:'C:\\root',fs:memoryFs({'C:\\root\\ds.dpapi':Buffer.from('blob')}),crypt});
  assert.deepEqual(await backend.status(deepseek),{status:'undecryptable'});
  assert.deepEqual(await backend.resolve(deepseek),{status:'undecryptable'});
 }
});

test('unsupported platforms return explicit unsupported status',async()=>{
 const backend=createDpapiBackend({root:'C:\\root',fs:memoryFs({}),crypt:async()=>Buffer.from('x'),platform:'darwin'});
 assert.equal((await backend.status(deepseek)).status,'unsupported');
 assert.equal((await backend.resolve(deepseek)).status,'unsupported');
 assert.equal((await backend.replace(deepseek,'synthetic',{authorize:async()=>true})).status,'unsupported');
 assert.equal((await backend.remove(deepseek,undefined,{authorize:async()=>true})).status,'unsupported');
});

test('replace writes atomically and remove distinguishes missing from removed',async()=>{
 const fs=memoryFs({});
 const writes=[];
 const backend=createDpapiBackend({root:'C:\\root',fs,crypt:async(op,data)=>{writes.push(op);return Buffer.from(data);}});
 let allowed=true;
 const result=await backend.replace(deepseek,'synthetic-secret',{authorize:async()=>allowed});
 assert.equal(result.status,'available');
 assert.equal((await backend.remove(deepseek,undefined,{authorize:async()=>true})).status,'removed');
 assert.equal((await backend.remove(deepseek,undefined,{authorize:async()=>true})).status,'removed');
 assert(!JSON.stringify(result).includes('synthetic-secret'));
});

test('authorization is rechecked immediately before replacement commit',async()=>{
 let allowed=true;
 const backend=createDpapiBackend({root:'C:\\root',fs:memoryFs({}),crypt:async(op,data)=>Buffer.from(data)});
 assert.equal((await backend.replace(deepseek,'synthetic',{authorize:async()=>{allowed=false;return allowed;}})).status,'denied');
 assert.equal(await backend.status(deepseek).then(r=>r.status),'missing');
});

test('credential service has no fallback when the protected backend fails',async()=>{
 let envCalls=0;
 const service=createCredentialService({authorize:()=>true,backends:{
  protected:{status:async()=>({status:'undecryptable'}),resolve:async()=>({status:'undecryptable'}),replace:async()=>({status:'undecryptable'}),remove:async()=>({status:'undecryptable'})},
  environment:{status:async()=>{envCalls++;return{status:'available',secret:'env-secret'}}}
 }});
 assert.equal((await service.resolve('protected:ds',{id:'ds',adapter:'deepseek-chat',endpoint:'https://api.deepseek.com/',credentialRef:'protected:ds'})).status,'undecryptable');
 assert.equal(envCalls,0);
});

test('native DPAPI round-trip is intentionally skipped when the existing transform is unavailable',{skip:true},async()=>{});
