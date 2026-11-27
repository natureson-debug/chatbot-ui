'use strict';
const catalog=require('./chat-models'),prefs=require('./routing-preferences'),router=require('./model-router');
const pair=c=>({providerId:c.id,model:c.model});
function failure(code){const e=Error(code);e.code=code;return e;}
function preferences(db,user){const raw=db.prepare('SELECT routing_preferences FROM user_settings WHERE user_id=?').get(user)?.routing_preferences;if(!raw)return prefs.defaults();try{const value=JSON.parse(raw);return prefs.validate(value,Object.values(value.priorities).flat());}catch{return prefs.defaults();}}
// Explicit operator attestation of non-billable providers, never inferred from URL/adapter.
function freeProviders(env=process.env){return new Set((env.CHATBOT_ROUTING_FREE_PROVIDERS||'').split(',').map(s=>s.trim()).filter(Boolean));}
async function select({db,user,connections,providers,selection,authorize,signal,free=freeProviders()}){
 const settings=preferences(db,user);if(!settings.enabled)return null;
 const config=structuredClone(await connections.read()),defaultModel=selection??catalog.defaultChoice(config,null);
 const profiles=new Map(),availability=new Map();const key=p=>JSON.stringify([p.providerId,p.model]);
 const candidates=[...settings.priorities.vision,...(defaultModel?[defaultModel]:[])];
 const deadline=AbortSignal.timeout(15000),bounded=signal?AbortSignal.any([signal,deadline]):deadline;
 for(const p of candidates){
  if(!authorize())throw failure('SESSION_EXPIRED');bounded.throwIfAborted();
  if(profiles.has(key(p)))continue;
  try{const c=catalog.resolve(config,p,null);if(c.adapter!=='ollama'||!free.has(c.id))continue;
   const base=config.connections.find(c=>c.id===p.providerId);
   const models=await providers.models(base,{signal:bounded});if(!models.some(m=>m.id===p.model))continue;
   const profile=await providers.capabilities(base,p.model,{signal:bounded});profiles.set(key(p),profile);availability.set(key(p),{...p,state:'available',checkedAt:new Date().toISOString()});
  }catch{if(bounded.aborted)throw failure('VISION_ROUTING_UNAVAILABLE');}
 }
 if(!authorize()||(await connections.read()).revision!==config.revision||JSON.stringify(preferences(db,user))!==JSON.stringify(settings))throw failure('VISION_ROUTING_CHANGED');
 const decision=router.decide({config,defaultModel,request:{hasImage:true},priorities:settings.priorities,
  authorize:(p,c)=>authorize()&&c.adapter==='ollama'&&free.has(c.id),costPolicy:()=> 'free',approvePaid:()=>false,
  availability:p=>availability.get(key(p)),capabilities:(c,m)=>profiles.get(key({providerId:c.id,model:m}))});
 if(!decision.selected)throw failure('NO_ELIGIBLE_VISION_MODEL');
 if(decision.fallbackUsed&&settings.fallback!=='next-eligible')throw failure(settings.fallback==='ask'?'VISION_FALLBACK_CONFIRMATION_REQUIRED':'VISION_FALLBACK_DISABLED');
 const selected=catalog.resolve(config,decision.selected,null);
 return {provider:{...selected,capabilities:{...selected.capabilities,vision:true}},decision,
  revalidate:async()=>authorize()&&(await connections.read()).revision===config.revision&&JSON.stringify(preferences(db,user))===JSON.stringify(settings),
  notice:settings.postTask==='return-default'?'temporary-vision-override':'post-task-preference-deferred-default-preserved'};
}
function currentImage(input){const last=input.messages?.at(-1);return last?.role==='user'&&require('./image-attachments').references(last.content).length>0;}
module.exports={select,preferences,freeProviders,currentImage,failure};
