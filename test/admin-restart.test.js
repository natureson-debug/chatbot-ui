'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {validRestartRequest}=require('../core/restart-request');
const {installAdminRestart}=require('../public/admin-restart');
test('restart requires exact same origin and explicit action header',()=>{
 const headers={host:'192.168.100.1',origin:'https://192.168.100.1','x-chatbot-action':'restart-ai','sec-fetch-site':'same-origin'};
 assert(validRestartRequest({headers}));
 for(const change of [{origin:undefined},{origin:'null'},{origin:'https://evil.invalid'},{origin:'http://192.168.100.1'},{'x-chatbot-action':undefined},{'sec-fetch-site':'cross-site'}])assert(!validRestartRequest({headers:{...headers,...change}}));
});
test('loopback desktop same-origin requests without Origin are accepted',()=>{
 const base={host:'127.0.0.1:3000','x-chatbot-action':'restart-ai','sec-fetch-site':'same-origin'};
 assert(validRestartRequest({headers:base}));
 assert(validRestartRequest({headers:{...base,host:'localhost:3000'}}));
 assert(!validRestartRequest({headers:{...base,host:'evil.invalid'}}));
 assert(!validRestartRequest({headers:{...base,'sec-fetch-site':'cross-site'}}));
});
function fixture(fetch,confirm=()=>true,notifications){let click;const button={disabled:false,addEventListener(_,fn){click=fn}},status={};installAdminRestart({document:{getElementById:id=>id==='restartAiServer'?button:status},fetch,confirm,notifications});return{click,button,status};}
test('cancelled confirmation never submits',async()=>{const f=fixture(()=>{throw Error('Must not request')},()=>false);await f.click();assert.equal(f.button.disabled,false);});
test('duplicate clicks suppressed; unknown ownership refuses without success',async()=>{
 let release,calls=0;const f=fixture(async(url,options)=>{calls++;assert.equal(url,'/api/admin/ai/restart');assert.equal(options.body,undefined);assert.equal(options.headers['X-Chatbot-Action'],'restart-ai');await new Promise(r=>release=r);return{ok:false,json:async()=>({ownership:'unverified',code:'LIFECYCLE_ACTIVATION_DISABLED'})};});
 const first=f.click();await f.click();assert.equal(calls,1);assert.equal(f.button.disabled,true);release();await first;assert.match(f.status.textContent,/Ownership unknown/);assert.equal(f.button.disabled,false);
});
test('transport uncertainty and accepted-only replies never show success or allow retry',async()=>{
 for(const fetch of [async()=>{throw Error('private')},async()=>({ok:true,json:async()=>({state:'accepted'})})]){const f=fixture(fetch);await f.click();assert.equal(f.button.disabled,true);assert(!f.status.textContent.includes('private'));assert.match(f.status.textContent,/unknown|unverified/);}
});
test('restart outcomes emit one safe notification and retain interlock status',async()=>{
 for(const [response,severity,locked] of [
  [{ok:true,json:async()=>({state:'accepted'})},'warning',true],
  [{ok:false,json:async()=>({state:'blocked'})},'error',false],
  [{ok:false,json:async()=>({code:'LIFECYCLE_ACTIVATION_DISABLED'})},'warning',false],
  [null,'warning',true]
 ]){
  const notices=[];const f=fixture(async()=>{if(!response)throw Error('synthetic-secret');return response;},()=>true,{show:n=>notices.push(n)});
  await f.click();assert.equal(notices.length,1);assert.equal(notices[0].severity,severity);
  assert.doesNotMatch(JSON.stringify(notices),/synthetic-secret|restart successful/i);
  assert.equal(f.button.disabled,locked);assert.ok(f.status.textContent);
 }
});
test('notification rendering failure preserves restart safety status',async()=>{
 const f=fixture(async()=>({ok:true,json:async()=>({state:'accepted'})}),()=>true,{show(){throw Error('private')}});
 await f.click();assert.equal(f.button.disabled,true);assert.match(f.status.textContent,/unverified/);
});
test('notification module may initialize after restart controls',async()=>{
 const notices=[];const f=fixture(async()=>({ok:true,json:async()=>({state:'accepted'})}));
 globalThis.ChatbotNotifications={show:n=>notices.push(n)};
 try{await f.click();assert.equal(notices.length,1);assert.equal(notices[0].severity,'warning');}
 finally{delete globalThis.ChatbotNotifications;}
});
