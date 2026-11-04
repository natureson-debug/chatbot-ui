'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
test('actual credential GUI clears password and requires paid-test confirmation',async()=>{
 const source=fs.readFileSync('public/admin-connections.js','utf8');const fields={providerKeyStatus:{},providerTestStatus:{},providerApiKey:{value:'synthetic-secret'},providerModel:{value:'deepseek-chat'}};let confirmed=false,calls=[];
 const context={editingId:'ds',document:{getElementById:id=>fields[id]},window:{confirm:()=>confirmed},api:async(url,options)=>{calls.push({url,options});return {configured:true};}};vm.createContext(context);vm.runInContext(source.slice(source.indexOf(' async function keyOperation('),source.indexOf(" document.getElementById('saveProviderKey').addEventListener")),context);
 await context.keyOperation('test');assert.equal(calls.length,0);await context.keyOperation('save');assert.equal(fields.providerApiKey.value,'');assert.equal(fields.providerKeyStatus.textContent,'Configured');assert(!fields.providerTestStatus.textContent.includes('synthetic-secret'));
 confirmed=true;await context.keyOperation('test');assert.equal(JSON.parse(calls.at(-1).options.body).confirmPaidTest,true);assert.equal(JSON.parse(calls.at(-1).options.body).model,'deepseek-chat');
});
test('protected provider readiness uses GUI authorization without enabling OpenAI or environment providers',()=>{
 const models=require('../core/provider-models'),old=process.env.CHATBOT_DEEPSEEK_ENABLED,openai=process.env.CHATBOT_OPENAI_RESPONSES_ENABLED;delete process.env.CHATBOT_DEEPSEEK_ENABLED;delete process.env.CHATBOT_OPENAI_RESPONSES_ENABLED;
 try{const c={id:'ds',adapter:'deepseek-chat',credentialRef:'protected:ds',enabled:true,model:'deepseek-chat',models:[{id:'deepseek-chat',enabled:true,chat:true}]};assert(models.ready(c));assert(!models.ready({...c,enabled:false}));assert(!models.ready({...c,credentialRef:'env:CHATBOT_DEEPSEEK_API_KEY'}));assert(!models.ready({...c,adapter:'openai-responses',credentialRef:'env:CHATBOT_OPENAI_KEY'}));}finally{if(old!==undefined)process.env.CHATBOT_DEEPSEEK_ENABLED=old;if(openai!==undefined)process.env.CHATBOT_OPENAI_RESPONSES_ENABLED=openai;}
});
test('DeepSeek GUI has one credential panel, password input, stream toggle and requested registry presets',()=>{
 const html=fs.readFileSync('public/admin.html','utf8');assert.equal(html.split('id="providerProtectedKey"').length-1,1);assert(/id="providerApiKey" type="password"/.test(html));assert(html.includes('id="providerStreaming"'));assert.deepEqual(require('../core/provider-presets.json').find(p=>p.id==='deepseek').models,['deepseek-chat','deepseek-reasoner']);
});
