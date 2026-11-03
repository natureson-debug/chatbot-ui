'use strict';
(()=>{
 const form=document.getElementById('openaiSafeguards'),status=document.getElementById('openaiUsageStatus'),view=document.getElementById('openaiUsageSummary');
 const fields=['max_output_tokens','max_concurrent','per_hour','per_day','estimated_daily_usd'];
 const field=name=>form.elements.namedItem(name);
 async function load(body){
  try{
   const r=await fetch('/api/admin/ai/openai-usage',{method:body?'POST':'GET',credentials:'same-origin',cache:'no-store',headers:{'Content-Type':'application/json','X-Chatbot-Action':'configure-openai'},...(body?{body:JSON.stringify(body)}:{})});
   if(!r.ok)throw Error('HTTP '+r.status);const data=await r.json();
   field('enabled').checked=!!data.settings.enabled;for(const name of fields)field(name).value=data.settings[name]??'';
   const n=x=>x===null||x===undefined?'N/A':String(x),d=data.today;
   view.textContent=`Environment gate: ${data.environmentEnabled?'enabled':'disabled'} | Admin switch: ${data.settings.enabled?'enabled':'disabled'}\nRequests today (UTC): ${n(d.requests)} | Completed: ${n(d.completed)} | Failed: ${n(d.failed)} | Cancelled: ${n(d.cancelled)} | Incomplete: ${n(d.incomplete)} | Interrupted: ${n(d.interrupted)}\nKnown input tokens: ${n(d.inputTokens)} | Known output tokens: ${n(d.outputTokens)} | Requests with unknown input usage: ${n(d.unknownUsage)}\nCurrent concurrency: ${n(data.currentConcurrency)}\nCost: unavailable. Unknown usage is not zero cost.`;
   status.textContent=body?'Safeguards saved. Existing requests are not automatically cancelled.':'';
  }catch{status.textContent='OpenAI usage/safeguards unavailable. No success confirmed.';}
 }
 form.addEventListener('submit',event=>{event.preventDefault();const body={enabled:field('enabled').checked};for(const name of fields)body[name]=field(name).value===''?null:Number(field(name).value);void load(body);});
 document.getElementById('refreshOpenaiUsage').addEventListener('click',()=>load());void load();
})();
