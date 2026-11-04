'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
test('provider switching shows only relevant safeguards and retains field values',()=>{
 const panels=['openai','deepseek'].map(providerSafeguards=>({dataset:{providerSafeguards},hidden:true,settings:{enabled:true,max:16}})),key={},option={};
 const context={document:{querySelectorAll:selector=>selector.includes('="deepseek"')?[panels[1]]:panels,getElementById:()=>key,querySelector:()=>option}};
 vm.runInNewContext(fs.readFileSync('public/admin-provider-ui.js','utf8'),context);
 for(const provider of ['deepseek','openai','ollama',null]){context.AdminProviderUI.select(provider,'protected');assert.deepEqual(panels.map(p=>p.hidden),panels.map(p=>p.dataset.providerSafeguards!==provider));assert.equal(key.hidden,provider!=='deepseek');assert.equal(option.disabled,provider!=='deepseek');assert.equal(panels[0].settings.max,16);assert.equal(panels[1].settings.enabled,true);}
});
test('inline test feedback allowlists diagnostics and does not reveal raw error fields',()=>{
 const context={};vm.runInNewContext(fs.readFileSync('public/admin-provider-ui.js','utf8'),context);
 const text=context.AdminProviderUI.testResult({success:false,model:'approved',httpStatus:401,responseTimeMs:12,usage:{promptTokens:null,generatedTokens:0},error:'sensitive upstream detail',apiKey:'secret'});
 assert(text.includes('Connection test failed'));assert(text.includes('HTTP status: 401'));assert(text.includes('Input tokens: N/A'));assert(text.includes('Output tokens: 0'));assert(!text.includes('sensitive'));assert(!text.includes('secret'));
 assert(context.AdminProviderUI.testResult({success:true}).includes('Connection test succeeded'));
});
test('theme bootstrap preserves supported themes and maps legacy amber phosphor to Light',()=>{
 const source=fs.readFileSync('public/theme-preference.js','utf8');
 for(const saved of ['dark','light','normal-dark','normal-light',null,'invalid']){
  const writes=[],context={document:{body:{dataset:{}}},localStorage:{getItem:()=>saved,setItem:(k,v)=>writes.push([k,v])}};vm.runInNewContext(source,context);
  const expected=saved==='light'?'normal-light':['dark','normal-dark','normal-light'].includes(saved)?saved:'dark';
  assert.equal(context.document.body.dataset.theme,expected);context.ChatbotTheme.remember('normal-light');assert.deepEqual(writes,[['chatbot.theme','normal-light']]);
 }
 const context={document:{body:{dataset:{}}},localStorage:{getItem:()=>{throw Error();},setItem:()=>{throw Error();}}};vm.runInNewContext(source,context);assert.equal(context.document.body.dataset.theme,'dark');assert.doesNotThrow(()=>context.ChatbotTheme.remember('light'));
});
test('theme runs before login/admin content and provider safeguards stay within the editor',()=>{
 const index=fs.readFileSync('public/index.html','utf8'),admin=fs.readFileSync('public/admin.html','utf8');assert(index.indexOf('/theme-preference.js')<index.indexOf('id="loginScreen"'));assert(admin.indexOf('/theme-preference.js')<admin.indexOf('class="admin-shell"'));
 for(const family of ['openai','deepseek'])assert(admin.includes('data-provider-safeguards="'+family+'" hidden'));
 assert(admin.indexOf('/admin-provider-ui.js')<admin.indexOf('/admin-connections.js'));
 const editor=admin.indexOf('id="providerEditor"'),providerFormEnd=admin.indexOf('</form>',admin.indexOf('id="providerForm"'));
 assert(admin.indexOf('id="providerList"')<editor);
 assert(providerFormEnd<admin.indexOf('data-provider-safeguards="openai"'));
 const deepseekStart=admin.indexOf('data-provider-safeguards="deepseek"'),deepseekEnd=admin.indexOf('</section>',deepseekStart);
 assert(deepseekEnd<admin.indexOf('</div>',deepseekEnd));
 assert.equal((admin.match(/data-provider-safeguards="openai"/g)||[]).length,1);
 assert.equal((admin.match(/data-provider-safeguards="deepseek"/g)||[]).length,1);
 assert.match(admin,/<h1>CHATBOT \/\/ ADMIN<\/h1>/);
 assert.doesNotMatch(admin,/ROBCO|TERMLINK|SYSTEM ADMIN|SECURE TERMINAL/);
});
