'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {validRestartRequest}=require('../core/restart-request');
const {installAdminRestart}=require('../public/admin-restart');
test('restart requires exact same origin and explicit action header',()=>{
 const headers={host:'192.168.100.1',origin:'https://192.168.100.1','x-chatbot-action':'restart-ai','sec-fetch-site':'same-origin'};
 assert(validRestartRequest({headers}));
 for(const change of [{origin:undefined},{origin:'null'},{origin:'https://evil.invalid'},{origin:'http://192.168.100.1'},{'x-chatbot-action':undefined},{'sec-fetch-site':'cross-site'}])assert(!validRestartRequest({headers:{...headers,...change}}));
});
function fixture(fetch,confirm=()=>true){let click;const button={disabled:false,addEventListener(_,fn){click=fn}},status={};installAdminRestart({document:{getElementById:id=>id==='restartAiServer'?button:status},fetch,confirm});return{click,button,status};}
test('cancelled confirmation never submits',async()=>{const f=fixture(()=>{throw Error('Must not request')},()=>false);await f.click();assert.equal(f.button.disabled,false);});
test('duplicate clicks suppressed; unknown ownership refuses without success',async()=>{
 let release,calls=0;const f=fixture(async(url,options)=>{calls++;assert.equal(url,'/api/admin/ai/restart');assert.equal(options.body,undefined);assert.equal(options.headers['X-Chatbot-Action'],'restart-ai');await new Promise(r=>release=r);return{ok:false,json:async()=>({ownership:'unverified',code:'LIFECYCLE_ACTIVATION_DISABLED'})};});
 const first=f.click();await f.click();assert.equal(calls,1);assert.equal(f.button.disabled,true);release();await first;assert.match(f.status.textContent,/Ownership unknown/);assert.equal(f.button.disabled,false);
});
test('transport uncertainty and accepted-only replies never show success or allow retry',async()=>{
 for(const fetch of [async()=>{throw Error('private')},async()=>({ok:true,json:async()=>({state:'accepted'})})]){const f=fixture(fetch);await f.click();assert.equal(f.button.disabled,true);assert(!f.status.textContent.includes('private'));assert.match(f.status.textContent,/unknown|unverified/);}
});
