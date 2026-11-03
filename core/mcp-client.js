'use strict';
const {Client}=require('@modelcontextprotocol/sdk/client/index.js');
const {StreamableHTTPClientTransport}=require('@modelcontextprotocol/sdk/client/streamableHttp.js');
const {StdioClientTransport}=require('@modelcontextprotocol/sdk/client/stdio.js');
async function withMcp(config,action,{signal}={}){
 const client=new Client({name:'Chatbot',version:'1.0.0'},{capabilities:{}});
 const bounded=signal?AbortSignal.any([signal,AbortSignal.timeout(10000)]):AbortSignal.timeout(10000);
 let transport;
 if(config.transport==='stdio'){
  if(typeof config.command!=='string'||!config.command.trim()||/[\x00-\x1f\x7f]/.test(config.command)||!Array.isArray(config.args))throw Error('Invalid MCP stdio server');
  transport=new StdioClientTransport({command:config.command,args:config.args,stderr:'ignore'});
 } else {
  let url;try{url=new URL(config.url);}catch{throw Error('Invalid MCP endpoint');}
  if(url.protocol!=='https:'||url.username||url.password||url.hash||url.search)throw Error('Invalid MCP endpoint');
  const headers={};if(config.credentialRef){if(!/^env:CHATBOT_[A-Z0-9_]+$/.test(config.credentialRef))throw Error('Invalid credential reference');const key=process.env[config.credentialRef.slice(4)];if(!key)throw Error('MCP credential unavailable');headers.Authorization='Bearer '+key;}
  transport=new StreamableHTTPClientTransport(url,{reconnectionOptions:{maxRetries:0,initialReconnectionDelay:1000,maxReconnectionDelay:1000,reconnectionDelayGrowFactor:1},requestInit:{headers,redirect:'error'},fetch:async(u,options)=>{
   if(new URL(u).origin!==url.origin)throw Error('MCP origin changed');const r=await fetch(u,{...options,redirect:'error',signal:options?.signal?AbortSignal.any([options.signal,bounded]):bounded});return r;
  }});
 }
 try{await client.connect(transport,{signal:bounded,timeout:8000});bounded.throwIfAborted();return await action(client,bounded);}catch{throw Error('MCP operation unavailable');}finally{await client.close().catch(()=>{});await transport.close().catch(()=>{});}
}
async function discover(config,options){return withMcp(config,async(c,signal)=>{const r=await c.listTools({}, {signal,timeout:8000});return r.tools.slice(0,100).map(t=>({name:t.name,description:String(t.description||'').slice(0,1000),inputSchema:t.inputSchema}));},options);}
async function invoke(config,name,args,options){if(!config.enabledTools?.includes(name))throw Error('MCP tool disabled');return withMcp(config,async(c,signal)=>{const r=await c.callTool({name,arguments:args},undefined,{signal,timeout:8000});if(JSON.stringify(r).length>32768)throw Error('MCP output too large');return r;},options);}
module.exports={discover,invoke};
