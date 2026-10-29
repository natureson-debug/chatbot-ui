'use strict';
const {spawn}=require('node:child_process');
function deadline(p,ms){let t;return Promise.race([p,new Promise((_,no)=>t=setTimeout(()=>no(Error('BROKER_TIMEOUT')),ms))]).finally(()=>clearTimeout(t));}
async function open(executable,cwd) {
 const p=spawn(executable,['--bridge'],{cwd,shell:false,detached:false,windowsHide:true,stdio:['pipe','pipe','pipe']});
 let buffer='',queue=[],waiting=[],closed=false;
 const exit=new Promise(resolve=>p.once('exit',code=>{closed=true;p.stdin.destroy();p.stdout.destroy();p.stderr.destroy();while(waiting.length)waiting.shift().reject(Error('BROKER_CLOSED'));resolve(code);}));
 p.once('error',()=>{closed=true;while(waiting.length)waiting.shift().reject(Error('BROKER_UNAVAILABLE'));});
 p.stdin.on('error',()=>{});p.stderr.on('data',()=>{});
 p.stdout.on('data',b=>{
  buffer+=b.toString('utf8');
  if(buffer.length>65536){p.stdin.end();return;}
  while(buffer.includes('\n')){
   const i=buffer.indexOf('\n');let row;
   try{row=JSON.parse(buffer.slice(0,i));}catch{p.stdin.end();return;}
   buffer=buffer.slice(i+1);
   if(waiting.length)waiting.shift().resolve(row);else queue.push(row);
  }
 });
 const next=()=>deadline(queue.length?Promise.resolve(queue.shift()):closed?Promise.reject(Error('BROKER_CLOSED')):new Promise((resolve,reject)=>waiting.push({resolve,reject})),15000);
 const hello=await next();if(hello.version!==1||!hello.nonElevated||!/^[a-f0-9]{32}$/.test(hello.token))throw Error('BROKER_IDENTITY');
 let sequence=1,busy=false,poisoned=false;
 return {pid:p.pid,exit,disconnect:()=>p.stdin.end(),
 async request(command){
  if(poisoned||busy||!['START','STATUS','STOP','QUIT'].includes(command))throw Error('INVALID_CONTROL');
  busy=true;try{
   p.stdin.write('V1 '+sequence+' '+hello.token+' '+command+'\n');
   if(command==='QUIT')return await deadline(exit,2000);
   const r=await next();if(r.nextSequence!==sequence+1)throw Error('BROKER_SEQUENCE');sequence++;
   return r;
  }catch(e){poisoned=true;throw Error('BROKER_UNVERIFIABLE');}finally{busy=false;}
 }};
}
module.exports={open,deadline};
