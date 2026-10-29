'use strict';
async function waitReady({observe,health,now,pause,end,cancelled,gpu=false}){
 while(now()<end){
  if(cancelled())throw Error('START_CANCELLED');
  const s=await observe(end-now());
  if(now()>=end)throw Error('STARTUP_TIMEOUT');
  if(s.status==='exited')return {exited:s};
  if(s.status!=='owned')throw Error('STARTUP_IDENTITY');
  if(s.listener&&await health(Math.min(3000,end-now()))){
   if(now()>=end)throw Error('STARTUP_TIMEOUT');
   if(!gpu||(s.offloaded===37&&s.totalLayers===37&&s.cudaModel&&s.cudaKV))return {ready:true};
  }
  await pause(Math.min(200,Math.max(0,end-now())));
 }
 throw Error('STARTUP_TIMEOUT');
}
module.exports={waitReady};
