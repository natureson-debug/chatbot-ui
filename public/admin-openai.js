'use strict';
for(const family of ['openai','deepseek']){
(()=>{
 const form=document.getElementById(family+'Safeguards'),status=document.getElementById(family+'UsageStatus'),view=document.getElementById(family+'UsageSummary');
 if(!form)return;
 const fields=['max_output_tokens','max_concurrent','per_hour','per_day','estimated_daily_usd'];
 const field=name=>form.elements.namedItem(name);
 async function load(body){
  try{
   const r=await fetch('/api/admin/ai/'+family+'-usage',{method:body?'POST':'GET',credentials:'same-origin',cache:'no-store',headers:{'Content-Type':'application/json','X-Chatbot-Action':'configure-'+family},...(body?{body:JSON.stringify(body)}:{})});
   if(!r.ok)throw Error('HTTP '+r.status);const data=await r.json();
   field('enabled').checked=!!data.settings.enabled;for(const name of fields)field(name).value=data.settings[name]??'';
   const n=x=>x===null||x===undefined?'N/A':String(x),d=data.today;
   view.textContent=(family==='deepseek'?`Environment credentials gate: ${data.environmentEnabled?'enabled':'disabled'} (only for environment references). Protected GUI credentials do not require this gate.\n`:`Environment gate: ${data.environmentEnabled?'enabled':'disabled'}\n`)+`Admin switch: ${data.settings.enabled?'enabled':'disabled'}\nRequests today (UTC): ${n(d.requests)} | Completed: ${n(d.completed)} | Failed: ${n(d.failed)} | Cancelled: ${n(d.cancelled)} | Incomplete: ${n(d.incomplete)} | Interrupted: ${n(d.interrupted)}\nKnown input tokens: ${n(d.inputTokens)} | Known output tokens: ${n(d.outputTokens)} | Requests with unknown input usage: ${n(d.unknownUsage)}\nCurrent concurrency: ${n(data.currentConcurrency)}\nCost: unavailable. Unknown usage is not zero cost.`;
   if(body){
    const message='Safeguards saved. Existing requests are not automatically cancelled.';
    try{if(!globalThis.ChatbotNotifications)throw Error('Notifications unavailable');globalThis.ChatbotNotifications.show({severity:'success',title:'Safeguards saved',message});status.textContent='';}
    catch{console.warn('Could not display safeguards notification.');status.textContent=message;}
   }else status.textContent='';
  }catch{
   const message=(family==='deepseek'?'DeepSeek':'OpenAI')+' usage/safeguards unavailable. No success confirmed.';
   if(!body){status.textContent=message;return;}
   try{if(!globalThis.ChatbotNotifications)throw Error('Notifications unavailable');globalThis.ChatbotNotifications.show({severity:'error',title:'Safeguards save failed',message});status.textContent='';}
   catch{console.warn('Could not display safeguards notification.');status.textContent=message;}
  }
 }
 form.addEventListener('submit',event=>{event.preventDefault();const body={enabled:field('enabled').checked};for(const name of fields)body[name]=field(name).value===''?null:Number(field(name).value);void load(body);});
 document.getElementById(family==='openai'?'refreshOpenaiUsage':'refreshDeepseekUsage').addEventListener('click',()=>load());if(form)void load();
})();
}
