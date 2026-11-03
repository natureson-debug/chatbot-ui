'use strict';
// Instructions/documents never change this registry or grant authorization.
function createToolPolicy({tools=[],confirm=async()=>false,timeoutMs=10000,maxOutput=32768}={}){
 const registry=new Map(tools.map(t=>[t.name,t])),operations=new Map();
 return {definitions:()=>tools.filter(t=>t.enabled).map(t=>({type:'function',function:{name:t.name,description:t.description,parameters:t.parameters}})),async execute({user,operationId,name,args,signal}){
  if(!user||typeof operationId!=='string'||!operationId||operationId.length>160)throw Error('Tool authorization required');
  const key=user+':'+operationId;if(operations.has(key))throw Error('Duplicate tool operation');if(operations.size>=10000)throw Error('Tool operation capacity reached');
  const t=registry.get(name);if(!t?.enabled||!t.allowed(user))throw Error('Tool not authorized');
  if(!args||typeof args!=='object'||Array.isArray(args)||JSON.stringify(args).length>8192)throw Error('Invalid tool arguments');
  operations.set(key,'reserved');
  if(t.consequential&&!await confirm({user,operationId,name,args})){operations.set(key,'denied');throw Error('Explicit action confirmation required');}
  const controller=new AbortController();const combined=signal?AbortSignal.any([signal,controller.signal]):controller.signal;let timer;
  try{combined.throwIfAborted();const result=await Promise.race([Promise.resolve().then(()=>t.run(args,{signal:combined})),new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(Error('Tool timeout; outcome unknown'));},timeoutMs);})]);combined.throwIfAborted();const text=JSON.stringify(result);if(text.length>maxOutput)throw Error('Tool output too large');operations.set(key,'completed');return{untrusted:true,result};}
  catch{operations.set(key,'uncertain');throw Error('Tool failed; automatic retry prohibited');}finally{clearTimeout(timer);}
 }};
}
async function runToolLoop({complete,messages,policy,user,operationId,signal,onActivity=()=>{},maxRounds=3,maxCalls=5}){
 const history=structuredClone(messages);let calls=0;
 for(let round=0;round<=maxRounds;round++){
  signal?.throwIfAborted();const message=await complete({messages:history,tools:policy.definitions(),signal});
  if(!message||message.role!=='assistant')throw Error('Invalid tool response');
  if(!message.tool_calls?.length)return message;
  if(round===maxRounds)throw Error('Tool round limit reached');history.push(message);
  for(const call of message.tool_calls){if(++calls>maxCalls)throw Error('Tool execution limit reached');if(call.type!=='function'||typeof call.id!=='string')throw Error('Invalid tool call');onActivity({state:'running',name:call.function.name});
   try{const result=await policy.execute({user,operationId:operationId+':'+call.id,name:call.function.name,args:JSON.parse(call.function.arguments),signal});history.push({role:'tool',tool_call_id:call.id,content:JSON.stringify(result)});onActivity({state:'completed',name:call.function.name});}catch{onActivity({state:'failed',name:call.function.name});throw Error('Tool operation failed');}
  }
 }
}
module.exports={createToolPolicy,runToolLoop};
