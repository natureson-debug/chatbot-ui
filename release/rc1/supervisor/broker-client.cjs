'use strict';
const {spawn}=require('node:child_process');
const {TIMEOUTS}=require('./timeouts.cjs');
// One outstanding frame. Timeout permanently revokes this channel, not ownership.
function attach(p,{setTimer=setTimeout,clearTimer=clearTimeout,timeouts=TIMEOUTS}={}){
 let pending=null,poisoned=false,buffer='',closed=false,sequence=1,busy=false;
 let closedResolve;const exit=new Promise(r=>{closedResolve=r;});
 const fail=code=>{poisoned=true;if(pending){const old=pending;pending=null;clearTimer(old.timer);old.reject(Error(code));}};
 const receive=(ms,kind)=>new Promise((resolve,reject)=>{
  if(poisoned||closed||pending){reject(Error('BROKER_UNVERIFIABLE'));return;}
  const timer=setTimer(()=>fail('BROKER_TIMEOUT'),ms);pending={resolve,reject,timer,kind};
 });
 // Armed before listeners and before any write.
 const hello=receive(timeouts.helloMs,'hello');
 p.stdout.on('data',b=>{
  if(poisoned)return;buffer+=b.toString('utf8');
  if(buffer.length>4096){fail('BROKER_OVERSIZE');return;}
  while(buffer.includes('\n')){
   const i=buffer.indexOf('\n'),line=buffer.slice(0,i);buffer=buffer.slice(i+1);
   let value;try{value=JSON.parse(line);}catch{fail('BROKER_PROTOCOL');return;}
   if(!pending||pending.kind==='exit'){fail('BROKER_UNSOLICITED');return;}
   const old=pending;pending=null;clearTimer(old.timer);old.resolve(value);
  }
 });
 p.stderr.on('data',()=>{});
 p.stdin.on('error',()=>fail('BROKER_WRITE_FAILED'));
 p.on('error',()=>fail('BROKER_UNAVAILABLE'));
 // close, unlike exit, confirms the Node-side output streams have closed.
 p.on('close',code=>{
  closed=true;closedResolve(code);
  if(pending?.kind==='exit'){const old=pending;pending=null;clearTimer(old.timer);old.resolve(code);}
  else fail('BROKER_CLOSED');
 });
 const ready=hello.then(h=>{
  if(poisoned||h?.version!==1||h.nonElevated!==true||typeof h.token!=='string'||!/^[a-f0-9]{32}$/.test(h.token)){
   fail('BROKER_IDENTITY');throw Error('BROKER_IDENTITY');
  }
  const token=h.token;
  return Object.freeze({pid:p.pid,exit,disconnect(){p.stdin.end();},
   async request(command,{timeoutMs}={}){
    if(poisoned||closed)throw Error('BROKER_UNVERIFIABLE');
    if(busy||!['START','STATUS','STOP','QUIT'].includes(command))throw Error('INVALID_CONTROL');
    const limit=command==='STOP'?timeouts.stopReplyMs:command==='QUIT'?timeouts.quitMs:timeouts.replyMs;
    if(timeoutMs!==undefined&&(!Number.isFinite(timeoutMs)||timeoutMs<=0))throw Error('DEADLINE_EXPIRED');
    busy=true;
    try{
     const reply=receive(Math.min(limit,timeoutMs??limit),command==='QUIT'?'exit':'reply');
     try{p.stdin.write('V1 '+sequence+' '+token+' '+command+'\n');}catch{fail('BROKER_WRITE_FAILED');}
     const value=await reply;
     if(poisoned)throw Error('BROKER_UNVERIFIABLE');
     if(command==='QUIT'){if(value!==0)throw Error('BROKER_EXIT_FAILED');return value;}
     if(value?.nextSequence!==sequence+1||typeof value.status!=='string')throw Error('BROKER_SEQUENCE');
     sequence++;return value;
    }catch{fail('BROKER_UNVERIFIABLE');throw Error('BROKER_UNVERIFIABLE');}
    finally{busy=false;}
   }
  });
 });
 return ready;
}
async function open(executable,cwd){
 const p=spawn(executable,['--bridge'],{cwd,shell:false,detached:false,windowsHide:true,stdio:['pipe','pipe','pipe']});
 return attach(p);
}
module.exports={open,attach};
