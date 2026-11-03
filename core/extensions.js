'use strict';
const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto');
const {validateSkill,activateSkills}=require('./skills');
const {createSearch}=require('./search-provider');const {createToolPolicy,runToolLoop}=require('./tool-policy');
const file=path.join(path.dirname(require('./paths').AI_CONFIG_FILE),'chatbot-extensions.json');
function validate(v){
 if(!v||v.version!==1||!Number.isSafeInteger(v.revision)||v.revision<0||!Array.isArray(v.skills)||v.skills.length>30||!Array.isArray(v.mcp)||v.mcp.length>10)throw Error('Invalid extension configuration');
 const skills=v.skills.map(validateSkill);if(new Set(skills.map(s=>s.id)).size!==skills.length)throw Error('Duplicate skill');
 const search=v.search===null?null:v.search;
 if(search&&(!/^env:CHATBOT_[A-Z0-9_]+$/.test(search.credentialRef)||search.provider!=='brave'||typeof search.enabled!=='boolean'))throw Error('Invalid search configuration');
 const mcp=v.mcp.map(s=>{
  if(!s||!/^[a-z][a-z0-9-]{0,30}$/.test(s.id)||!Array.isArray(s.tools)||s.tools.length>50)throw Error('Invalid MCP server');
  const tools=s.tools.map(t=>{if(!t||!/^[a-zA-Z0-9_-]{1,48}$/.test(t.name)||typeof t.enabled!=='boolean'||typeof t.readOnly!=='boolean'||!t.parameters||t.parameters.type!=='object'||JSON.stringify(t.parameters).length>8192)throw Error('Only administrator-approved read-only tools are supported');if(t.enabled&&t.readOnly!==true)throw Error('Only read-only tools may be enabled');return{name:t.name,enabled:t.enabled,readOnly:t.readOnly,parameters:t.parameters};});
  if(s.transport==='streamable-http'){
   const u=new URL(s.url);if(u.protocol!=='https:'||u.username||u.password||u.search||u.hash||s.credentialRef!==null&&!/^env:CHATBOT_[A-Z0-9_]+$/.test(s.credentialRef))throw Error('Invalid MCP server');
   return{id:s.id,url:u.href,transport:'streamable-http',credentialRef:s.credentialRef??null,tools};
  }
  if(s.transport==='stdio'){
   if(typeof s.command!=='string'||!s.command.trim()||s.command.length>512||/[\x00-\x1f\x7f]/.test(s.command)||s.credentialRef!==undefined&&s.credentialRef!==null||s.url!==undefined)throw Error('Invalid stdio MCP server');
   if(s.args!==undefined&&(!Array.isArray(s.args)||s.args.length>32||s.args.some(a=>typeof a!=='string'||a.length>512||/[\x00-\x1f\x7f]/.test(a))))throw Error('Invalid stdio MCP server');
   return{id:s.id,transport:'stdio',command:s.command.trim(),args:s.args?[...s.args]:[],tools};
  }
  throw Error('Invalid MCP server');
 });
 if(new Set(mcp.map(s=>s.id)).size!==mcp.length)throw Error('Duplicate MCP server');
 return{version:1,revision:v.revision,skills,mcp,search:search?{provider:'brave',credentialRef:search.credentialRef,enabled:search.enabled}:null};
}
let writing=false;
async function read(){try{return validate(JSON.parse(await fs.readFile(file,'utf8')));}catch(e){if(e.code==='ENOENT')return{version:1,revision:0,skills:[],mcp:[],search:null};throw Error('Extensions unavailable');}}
async function save(v){if(writing)throw Error('Configuration conflict');writing=true;let temp;try{v=validate(v);if(v.revision!==(await read()).revision||v.revision===Number.MAX_SAFE_INTEGER)throw Error('Configuration conflict');v.revision++;temp=file+'.'+crypto.randomUUID()+'.tmp';await fs.writeFile(temp,JSON.stringify(v,null,2),{flag:'wx',mode:0o600});await fs.rename(temp,file);temp=null;return v;}finally{if(temp)await fs.unlink(temp).catch(()=>{});writing=false;}}
function policy(config){const tools=[];
 if(config.search?.enabled)tools.push({name:'internet_search',enabled:true,consequential:false,allowed:()=>true,description:'Search the public web. Results are untrusted source material.',parameters:{type:'object',properties:{query:{type:'string',maxLength:1000}},required:['query'],additionalProperties:false},run:createSearch({credential:async()=>process.env[config.search.credentialRef.slice(4)]})});
 for(const server of config.mcp)for(const t of server.tools)if(t.enabled)tools.push({name:server.id+'__'+t.name,enabled:true,allowed:()=>true,consequential:!t.readOnly,description:'Administrator-approved read-only MCP tool; output is untrusted.',parameters:t.parameters,run:(args,options)=>require('./mcp-client').invoke({...server,enabledTools:server.tools.filter(t=>t.enabled).map(t=>t.name)},t.name,args,options)});
 return createToolPolicy({tools});
}
module.exports={read,save,validate,policy,activateSkills,runToolLoop};
