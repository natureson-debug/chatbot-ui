'use strict';
const dns=require('node:dns/promises'),https=require('node:https'),http=require('node:http');
const {isIP,BlockList}=require('node:net');
const {Readable}=require('node:stream');
const denied=new BlockList(),denied6=new BlockList();
for(const [ip,bits] of [['0.0.0.0',8],['10.0.0.0',8],['100.64.0.0',10],['127.0.0.0',8],['169.254.0.0',16],['172.16.0.0',12],['192.0.0.0',24],['192.0.2.0',24],['192.168.0.0',16],['198.18.0.0',15],['198.51.100.0',24],['203.0.113.0',24],['224.0.0.0',3]])denied.addSubnet(ip,bits,'ipv4');
for(const [ip,bits] of [['::',96],['::ffff:0:0',96],['64:ff9b::',96],['100::',64],['2001::',32],['2001:db8::',32],['2002::',16],['fc00::',7],['fe80::',10],['ff00::',8]])denied6.addSubnet(ip,bits,'ipv6');
function publicAddress(address){const family=isIP(address);return !!family&&!(family===4?denied:denied6).check(address,family===4?'ipv4':'ipv6');}
async function pinnedAddress(url,lookup,signal,{allowPrivate=false,allowLoopback=false}={}){
 const hostname=url.hostname.replace(/^\[|\]$/g,'');
 const entries=isIP(hostname)?[{address:hostname,family:isIP(hostname)}]:await lookup(hostname,{all:true,verbatim:true});
 signal?.throwIfAborted();
 const privateRanges=new BlockList();for(const [ip,bits] of [['10.0.0.0',8],['172.16.0.0',12],['192.168.0.0',16],['100.64.0.0',10]])privateRanges.addSubnet(ip,bits,'ipv4');privateRanges.addSubnet('fc00::',7,'ipv6');
 const permitted=address=>publicAddress(address)||allowPrivate&&privateRanges.check(address,isIP(address)===4?'ipv4':'ipv6')||allowLoopback&&(address==='::1'||/^127\./.test(address));
 if(!entries.length||entries.some(e=>!isIP(e.address)||!permitted(e.address)))throw Error('Unsafe cloud address');
 return entries[0];
}
function createCloudFetch({lookup=dns.lookup,request,allowPrivate=false,allowLoopback=false,allowHttp=false}={}){
 return async(input,options={})=>{
  const url=new URL(input);if(!(['https:'].includes(url.protocol)||allowHttp&&url.protocol==='http:')||url.username||url.password||url.hash)throw Error('Cloud HTTPS required');
  const signal=options.signal?AbortSignal.any([options.signal,AbortSignal.timeout(600000)]):AbortSignal.timeout(120000);
  signal.throwIfAborted();
  // DNS is resolved once, every returned address checked, and the selected
  // address pinned to this socket. TLS still validates the original hostname.
  const pinned=await new Promise((resolve,reject)=>{
   const abort=()=>reject(Error('Cloud request cancelled'));signal.addEventListener('abort',abort,{once:true});
   pinnedAddress(url,lookup,signal,{allowPrivate,allowLoopback}).then(resolve,reject).finally(()=>signal.removeEventListener('abort',abort));
  });
  return new Promise((resolve,reject)=>{
   let req;
   try{signal.throwIfAborted();options.beforeConnect?.();req=(request||(url.protocol==='https:'?https.request:http.request))(url,{method:options.method||'GET',headers:options.headers,signal,agent:false,
    lookup:(_host,opts,callback)=>opts.all?callback(null,[pinned]):callback(null,pinned.address,pinned.family)},response=>{
     try {
     if(response.statusCode>=300&&response.statusCode<400){response.destroy();reject(Error('Cloud redirect rejected'));return;}
     const headers=new Headers();for(const [key,value] of Object.entries(response.headers))if(value!==undefined)headers.set(key,Array.isArray(value)?value.join(', '):value);
     if([204,205,304].includes(response.statusCode)){response.resume();resolve(new Response(null,{status:response.statusCode,headers}));}
     else resolve(new Response(Readable.toWeb(response),{status:response.statusCode,headers}));
     } catch {response.destroy();reject(Error('Cloud response unavailable'));}
    });req.on('error',()=>reject(Error('Cloud request unavailable')));req.end(options.body);
   }catch{req?.destroy();reject(Error('Cloud request unavailable'));}
  });
 };
}
module.exports={createCloudFetch,publicAddress,pinnedAddress};
