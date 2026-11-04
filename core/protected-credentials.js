'use strict';
const fs=require('node:fs/promises'),path=require('node:path'),{spawn}=require('node:child_process'),{randomUUID}=require('node:crypto');
const fail=()=>Error('Protected credential unavailable');
function binding(c){if(c.adapter!=='deepseek-chat'||!/^[a-z][a-z0-9-]{0,47}$/.test(c.id)||c.credentialRef!=='protected:'+c.id)throw fail();return JSON.stringify(['chatbot-deepseek-v1',c.id,new URL(c.endpoint).href]);}
function transform(operation,data,entropy){
 if(process.platform!=='win32')return Promise.reject(fail());
 // The constant script takes all data on stdin, never in command lines or diagnostics.
 const script="$ErrorActionPreference='Stop'; try { Add-Type -AssemblyName System.Security; $r=[Console]::In.ReadToEnd()|ConvertFrom-Json; $b=[Convert]::FromBase64String($r.data); $e=[Text.Encoding]::UTF8.GetBytes($r.entropy); if($r.operation -eq 'protect'){$v=[Security.Cryptography.ProtectedData]::Protect($b,$e,[Security.Cryptography.DataProtectionScope]::CurrentUser)}elseif($r.operation -eq 'unprotect'){$v=[Security.Cryptography.ProtectedData]::Unprotect($b,$e,[Security.Cryptography.DataProtectionScope]::CurrentUser)}else{exit 1}; [Console]::Out.Write([Convert]::ToBase64String($v)) } catch {exit 1}";
 return new Promise((resolve,reject)=>{
  const executable=path.join(process.env.SystemRoot||'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
  const child=spawn(executable,['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{windowsHide:true,shell:false,stdio:['pipe','pipe','ignore']});
  let output='',bad=false;const timer=setTimeout(()=>{bad=true;child.kill();},8000);
  child.on('error',()=>{bad=true;});child.stdin.on('error',()=>{bad=true;});
  child.stdout.on('data',b=>{output+=b;if(output.length>32768){bad=true;child.kill();}});
  child.on('close',code=>{clearTimeout(timer);if(bad||code!==0||!output||!/^[A-Za-z0-9+/=]+$/.test(output))reject(fail());else resolve(Buffer.from(output,'base64'));});
  child.stdin.end(JSON.stringify({operation,data:Buffer.from(data).toString('base64'),entropy}));
 });
}
function createStore(root,crypt=transform){
 const location=c=>path.join(root,c.id+'.dpapi');
 return {
  async read(c){const entropy=binding(c);const file=await fs.readFile(location(c));if(file.length>32768)throw fail();const value=(await crypt('unprotect',file,entropy)).toString('utf8');if(!value||value.length>4096||/[\r\n\x00]/.test(value))throw fail();return value;},
  async configured(c){try{await this.read(c);return true;}catch{return false;}},
  async save(c,key,authorize=()=>true){const entropy=binding(c);if(typeof key!=='string'||!key.trim()||key.length>4096||/[\r\n\x00]/.test(key))throw fail();const encrypted=await crypt('protect',Buffer.from(key.trim()),entropy);await fs.mkdir(root,{recursive:true});const temp=location(c)+'.'+randomUUID()+'.tmp';try{await fs.writeFile(temp,encrypted,{flag:'wx',mode:0o600});if(!authorize())throw fail();await fs.rename(temp,location(c));}finally{await fs.unlink(temp).catch(()=>{});}},
  async remove(c,authorize=()=>true){binding(c);if(!authorize())throw fail();await fs.unlink(location(c)).catch(e=>{if(e.code!=='ENOENT')throw fail();});}
 };
}
const store=createStore(path.join(path.dirname(require('./paths').AI_CONFIG_FILE),'protected-credentials'));
module.exports={...store,createStore,transform,binding};
