'use strict';
const {openTestChannel}=require('./management-channel.cjs');
const {createActivationContract}=require('./activation-contract.cjs');
const transitions=Object.freeze({requested:['validated','failed','blocked','unverifiable'],validated:['accepted','failed','blocked','unverifiable'],accepted:['activating','unverifiable'],activating:['verifying','failed','blocked','unverifiable'],verifying:['succeeded','failed','blocked','unverifiable'],succeeded:[],failed:[],blocked:[],unverifiable:[]});
function transition(from,to){if(!transitions[from]?.includes(to))throw Error('INVALID_TRANSITION');return to;}
async function openCoordinator({mode,store,observe,simulate,leaseVerified,now=Date.now,timeoutMs=1000,schedule=setTimeout,cancel=clearTimeout}) {
 if(mode!=='TEST'||![observe,simulate,leaseVerified,now,schedule,cancel].every(f=>typeof f==='function')||!Number.isSafeInteger(timeoutMs)||timeoutMs<=0)throw Error('TEST_PROVIDERS_REQUIRED');
 const contract=createActivationContract({mode,now});let busy=false,poisoned=store.incomplete(),abortCurrent=null;
 const seen=new Set();
 const result=(state,code,trace=[])=>({mode:'TEST',state,code,trace,productionReady:false});
 const boundary={invalidate(){poisoned=true;if(abortCurrent)abortCurrent();},async run(r){
  if(poisoned)return result('unverifiable','INCOMPLETE_OR_POISONED');
  if(busy)return result('conflicting','OPERATION_BUSY');
  if(r.action!=='activate')return result('blocked','UNSUPPORTED_ACTION');
  if(seen.has(r.operationId))return result('blocked','REPLAY');
  if(seen.size>=1024)return result('blocked','CAPACITY');
  seen.add(r.operationId);busy=true;
  let state='requested',trace=[state],active=true,tx=null,timer;
  const started=now(),end=started+timeoutMs;
  const move=s=>{state=transition(state,s);trace.push(s);};
  const check=()=>{if(!active||poisoned||!Number.isSafeInteger(now())||now()<started||now()>=end||now()>=r.expiresAt||leaseVerified()!==true)throw Error('UNCERTAIN');};
  const finish=(s,code)=>{move(s);return result(s,code,[...trace]);};
  const work=async()=>{
   check();let bound;
   try {bound=store.bind(r);}catch(e){if(['UNKNOWN_REVISION','SUPERSEDED_REVISION','PROFILE_DIGEST_MISMATCH'].includes(e.code))return finish('failed',e.code);throw e;}
   const initial=await observe(bound);check();store.revalidate(bound);
   const admission=contract.validateRequest(r,initial);
   if(!admission.allowed)return finish('blocked',admission.code);
   move('validated');tx=store.beginActivation(r);bound=tx.bound;move('accepted');move('activating');
   // Injected providers simulate effects only. No executable paths/arguments are commands.
   const stopped=await simulate('stop',bound);check();
   if(!contract.validateReplacement(stopped,initial.retainedHandle).allowed)return finish('blocked','SHUTDOWN_UNVERIFIABLE');
   const launched=await simulate('launch',bound);check();
   if(!launched?.retainedHandle||launched.identityVerified!==true)throw Error('UNCERTAIN');
   move('verifying');const e=await simulate('verify',bound);check();store.revalidate(bound);
   const completion=contract.validateCompletion(r,{...e,expectedModelPath:bound.profile.settings.modelPath,expectedModelDigest:bound.profile.modelSha256},launched.retainedHandle,end);
   if(!completion.allowed)return finish('failed',completion.code);
   tx.finish(true);tx=null;return finish('succeeded','SIMULATION_SUCCEEDED');
  };
  try{
   return await Promise.race([work(),new Promise(resolve=>{
    const invalidate=code=>{if(!active)return;active=false;poisoned=true;resolve(finish('unverifiable',code));};
    abortCurrent=()=>invalidate('INTERRUPTED');timer=schedule(()=>invalidate('TIMEOUT'),timeoutMs);
   })]);
  }catch(_){poisoned=true;return finish('unverifiable','OBSERVATION_OR_PROVIDER_FAILURE');}
  finally{active=false;abortCurrent=null;cancel(timer);if(tx){try{tx.finish(false);}catch{}poisoned=true;}if(!poisoned)busy=false;}
 }};
 const channel=await openTestChannel({mode,boundary,now});
 return Object.freeze({channel,interrupt:()=>boundary.invalidate(),save(config){
  if(busy&&!poisoned)return result('conflicting','OPERATION_BUSY');
  if(poisoned||store.incomplete())return result('blocked','INCOMPLETE_OR_POISONED');
  busy=true;try{return { ...result('succeeded','CONFIGURATION_SAVED'),revision:store.append(config)};}
  catch(e){return result('failed',['STALE_REVISION','INVALID_REQUEST','UNAPPROVED_PROFILE'].includes(e.code)?e.code:'STORE_UNVERIFIABLE');}
  finally{busy=false;}
 }});
}
module.exports={openCoordinator,transition};
