'use strict';
// Isolated harness only. Never accepts production broker paths.
const {spawn}=require('node:child_process'),fs=require('node:fs'),path=require('node:path');
const [exe,mode,report]=process.argv.slice(2);
if(!exe.includes('chatbot-owned-test-')||!['broker-crash','supervisor-crash'].includes(mode))throw Error('FIXTURE_ONLY');
const p=spawn(exe,['--bridge'],{cwd:path.dirname(exe),windowsHide:true,stdio:['pipe','pipe','pipe']});
let token,seq=1,buffer='',waiting=false;
function send(c){p.stdin.write('V1 '+seq+' '+token+' '+c+'\n');}
p.stdout.on('data',bytes=>{buffer+=bytes;while(buffer.includes('\n')){
 const i=buffer.indexOf('\n'),r=JSON.parse(buffer.slice(0,i));buffer=buffer.slice(i+1);
 if(r.status==='hello'){token=r.token;send('START');continue;}
 seq=r.nextSequence;
 if(r.status==='owned'&&r.listener&&!waiting){
  waiting=true;fs.writeFileSync(report,JSON.stringify({pid:r.pid,created:r.created}));
  if(mode==='supervisor-crash')process.exit(86);
  send('CRASH_FIXTURE_BROKER'); // Compiled only into isolated fixture variants.
 }else if(r.status==='owned')setTimeout(()=>send('STATUS'),20);
}});
p.on('exit',code=>{p.stdin.destroy();p.stdout.destroy();p.stderr.destroy();if(!waiting)process.exitCode=1;});
setTimeout(()=>{console.error('FIXTURE_DRIVER_TIMEOUT');process.exit(2)},6000).unref();
