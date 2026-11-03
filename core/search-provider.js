'use strict';
function createSearch({credential,fetchImpl=fetch}){
 return async({query},{signal}={})=>{
  if(typeof query!=='string'||!query.trim()||query.length>1000)throw Error('Invalid search query');
  const key=await credential();if(!key)throw Error('Search credential unavailable');
  const url=new URL('https://api.search.brave.com/res/v1/web/search');url.searchParams.set('q',query);url.searchParams.set('count','5');
  try{const r=await fetchImpl(url,{headers:{'X-Subscription-Token':key,Accept:'application/json'},redirect:'error',signal:signal?AbortSignal.any([signal,AbortSignal.timeout(8000)]):AbortSignal.timeout(8000)});if(!r.ok){await r.body?.cancel();throw Error();}let size=0,parts=[];for await(const b of r.body){size+=b.length;if(size>262144)throw Error();parts.push(b);}const data=JSON.parse(Buffer.concat(parts).toString());return (data.web?.results||[]).slice(0,5).filter(x=>{try{return new URL(x.url).protocol==='https:'}catch{return false}}).map(x=>({title:String(x.title).slice(0,300),url:x.url,description:String(x.description||'').slice(0,2000),untrusted:true}));}catch{throw Error('Search unavailable');}
 };
}
module.exports={createSearch};
