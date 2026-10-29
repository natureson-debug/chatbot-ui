'use strict';
const {DEFAULTS}=require('C:/AI/chatbot-ui/core/lifecycle-policy.js');
// Reuses policy constants, not TEST effects. Production recovery never stops a live unhealthy child.
function budget(now,settings=DEFAULTS){
 let attempts=[],last=-1,stopped=false;
 return {
  suppress(){stopped=true;},
  next(evidence){
   const t=now();if(!Number.isSafeInteger(t)||t<last)throw Error('CLOCK_INVALID');last=t;
   if(stopped)return null;
   if(evidence.process!=='exited'||!evidence.streamsClosed||!evidence.listenerReleased)throw Error('REPLACEMENT_UNSAFE');
   attempts=attempts.filter(n=>t-n<settings.recoveryWindowMs);
   if(attempts.length>=settings.recoveryLaunches)return null;
   const delay=settings.backoffMs[Math.min(attempts.length,settings.backoffMs.length-1)];
   attempts.push(t);return delay;
  }
 };
}
function classify(observation){
 if(!observation||!['absent','external'].includes(observation.state))throw Error('OBSERVATION_BLOCKED');
 if(observation.state==='external'&&(!observation.identityObserved||!observation.pid||!observation.created))throw Error('IDENTITY_BLOCKED');
 return observation.state;
}
module.exports={budget,classify};
