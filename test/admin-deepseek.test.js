'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
test('DeepSeek admin view shows real unknown metrics and submits bounded configuration without secrets',async()=>{
 const fields={};for(const key of ['enabled','max_output_tokens','max_concurrent','per_hour','per_day','estimated_daily_usd'])fields[key]={value:'',checked:false};
 const listeners={},form={elements:{namedItem:key=>fields[key]},addEventListener:(name,fn)=>listeners[name]=fn},view={},status={},refresh={addEventListener:(_,fn)=>listeners.refresh=fn};let calls=[];
 const context={document:{getElementById:id=>({deepseekSafeguards:form,deepseekUsageSummary:view,deepseekUsageStatus:status,refreshDeepseekUsage:refresh})[id]},fetch:async(url,options)=>{calls.push({url,options});return {ok:true,json:async()=>({environmentEnabled:false,settings:{enabled:0,max_output_tokens:32,max_concurrent:1,per_hour:2,per_day:3,estimated_daily_usd:null},today:{requests:0,completed:0,failed:0,cancelled:0,inputTokens:null,outputTokens:null,unknownUsage:0},currentConcurrency:0})};}};
 vm.runInNewContext(fs.readFileSync('public/admin-openai.js','utf8'),context);await new Promise(r=>setImmediate(r));assert(view.textContent.includes('input tokens: N/A'));assert(view.textContent.includes('Environment gate: disabled'));assert.equal(calls.length,1);
 fields.enabled.checked=true;listeners.submit({preventDefault(){}});await new Promise(r=>setImmediate(r));const request=calls[1];assert.equal(request.options.headers['X-Chatbot-Action'],'configure-deepseek');assert.equal(JSON.parse(request.options.body).enabled,true);assert.equal(JSON.parse(request.options.body).estimated_daily_usd,null);assert(!request.options.headers.Authorization);
});
