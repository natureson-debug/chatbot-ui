'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createCredentialService:create}=require('../core/credential-service');
const reference='protected:fixture',context={id:'fixture',adapter:'deepseek-chat',endpoint:'https://fixture.invalid',credentialRef:reference};
const secret='synthetic-fixture-secret';
function service(backend,authorize=()=>true){return create({backends:{protected:backend},authorize});}
for(const status of ['available','missing','inaccessible','undecryptable','unsupported'])test('structured '+status+' without backend metadata',async()=>{
 const s=service({status:async()=>({status,secret,path:'sensitive',output:secret})});const r=await s.status(reference,context);
 assert.equal(r.status,status);assert.deepEqual(Object.keys(r),['status','code']);assert(!JSON.stringify(r).includes(secret));
});
test('resolve exposes a secret only to authorized consumers',async()=>{
 const backend={resolve:async()=>({status:'available',secret})};assert.equal((await service(backend).resolve(reference,context)).secret,secret);
 assert.equal((await service(backend,()=>false).resolve(reference,context)).code,'CREDENTIAL_ACCESS_DENIED');
 assert.equal((await create({backends:{protected:backend}}).resolve(reference,context)).status,'denied');
});
test('invalid references and binding mismatches never reach backend',async()=>{
 const s=service({resolve:()=>{throw Error('must not execute');}});
 for(const ref of ['bad','protected:other','env:PATH',null])assert.equal((await s.resolve(ref,context)).status,'invalid');
 assert.equal((await s.status(reference,{...context,endpoint:'not-url'})).status,'invalid');
});
test('replace validates secrets; removal is idempotent',async()=>{
 let value;const s=service({replace:async(d,v,g)=>{assert(await g.authorize());value=v;return{status:'available',secret:v};},remove:async()=>{const status=value?'removed':'missing';value=null;return{status};}});
 for(const v of ['', ' ', 'a\nb',null,'x'.repeat(4097)])assert.equal((await s.replace(reference,v,context)).status,'invalidSecret');
 assert.deepEqual(await s.replace(reference,secret,context),{status:'available',code:'CREDENTIAL_AVAILABLE'});
 assert.equal(value,secret);assert.equal((await s.remove(reference,context)).status,'removed');assert.equal((await s.remove(reference,context)).status,'removed');
});
test('backend exceptions and malformed output cannot leak secrets',async()=>{
 const s=service({resolve:async()=>{throw Error('C:\\private '+secret);},status:async()=>({status:secret})});
 for(const method of ['resolve','status']){const r=await s[method](reference,context);assert.equal(r.status,'failure');assert(!JSON.stringify(r).includes(secret));}
});
test('decryption failure has no automatic environment fallback',async()=>{
 let envCalls=0;const s=create({authorize:()=>true,backends:{protected:{resolve:async()=>({status:'undecryptable'})},environment:{resolve:()=>{envCalls++;return{status:'available',secret};}}}});
 assert.equal((await s.resolve(reference,context)).status,'undecryptable');assert.equal(envCalls,0);
});
test('environment, Brave and legacy formats retain separate backend selection',async()=>{
 const seen=[];const backend={status:async d=>{seen.push(d);return{status:'missing'};}};
 const s=create({authorize:()=>true,backends:{environment:backend,protected:backend,legacyLocal:backend}});
 await s.status('env:CHATBOT_FIXTURE',{credentialRef:'env:CHATBOT_FIXTURE'});
 await s.status('protected:brave-search',{credentialRef:'protected:brave-search',provider:'brave-search'});
 await s.status('local-api-key',{credentialRef:'local-api-key',adapter:'llama.cpp',endpoint:'http://127.0.0.1:8080/v1'});
 assert.deepEqual(seen.map(x=>x.source),['environment','protected','legacyLocal']);assert.equal(seen[1].binding,'["chatbot-brave-search-v1"]');
});
test('DeepSeek binding is captured before asynchronous work',async()=>{
 const c={...context};let target;const s=service({status:async d=>{target=d;return{status:'available'};}},async()=>{c.endpoint='https://changed.invalid';return true;});
 await s.status(reference,c);assert.equal(target.binding,'["chatbot-deepseek-v1","fixture","https://fixture.invalid/"]');assert(Object.isFrozen(target));
});
test('authorization revoked during resolution suppresses plaintext',async()=>{
 let authorized=true;const s=service({resolve:async()=>{authorized=false;return{status:'available',secret};}},()=>authorized);
 assert.deepEqual(await s.resolve(reference,context),{status:'denied',code:'CREDENTIAL_ACCESS_DENIED'});
});
test('absent backend fails unsupported without accessing platform resources',async()=>{
 assert.equal((await create({authorize:()=>true}).status(reference,context)).status,'unsupported');
});
