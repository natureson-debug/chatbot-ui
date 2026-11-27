'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { decide, classify } = require('../core/model-router');
const now = Date.now(), pair = n => ({ providerId: 'p' + n, model: 'm' + n });
function fixture() {
 const config = { defaultId: 'p1', connections: [1,2,3].map(n => ({ id:'p'+n, name:'Provider', adapter:'ollama', enabled:true, model:'m'+n, parameters:[], capabilities:{streaming:true,tools:true} })) };
 return { config, now, defaultModel:pair(1), authorize:()=>true, costPolicy:()=> 'free',
  availability:p=>({...p,state:'available',checkedAt:new Date(now).toISOString()}),
  capabilities:(c,m)=>({providerId:c.id,model:m,checkedAt:new Date(now).toISOString(),capabilities:Object.fromEntries(['text','vision','tools','documents'].map(k=>[k,{state:'verified',scope:k==='documents'?'application':'native'}]))}) };
}
test('text retains default, explicit task classification and no mutation',()=>{
 const f=fixture(), before=JSON.stringify(f.config), selection=JSON.stringify(f.defaultModel);
 const r=decide({...f,priorities:{text:[pair(2)]}});assert.deepEqual(r.selected,pair(1));assert.equal(r.fallbackUsed,false);
 assert.equal(JSON.stringify(f.config),before);assert.equal(JSON.stringify(f.defaultModel),selection);
 assert.equal(classify({hasImage:true,task:'coding'}),'vision');assert.equal(classify({task:'coding'}),'coding');assert.equal(classify({task:'bogus'}),null);
});
test('vision requires fresh verified native metadata and compatible image adapter',()=>{
 for(const state of ['unknown','unsupported']){const f=fixture(), original=f.capabilities;f.capabilities=(c,m)=>{const p=original(c,m);p.capabilities.vision.state=state;return p;};assert.equal(decide({...f,request:{hasImage:true}}).selected,null);}
 const f=fixture();f.config.connections[0].adapter='openai-compatible';assert.equal(decide({...f,request:{task:'vision'}}).candidates[0].reason,'image-adapter-unsupported');
 assert.deepEqual(decide({...fixture(),request:{hasImage:true}}).selected,pair(1));
});
test('priority order and unavailable preferred fallback',()=>{
 const f=fixture(), args={...f,request:{task:'coding'},priorities:{coding:[pair(2),pair(3)]}};
 assert.deepEqual(decide(args).selected,pair(2));const r=decide({...args,availability:p=>({...f.availability(p),state:p.providerId==='p2'?'unavailable':'available'})});assert.deepEqual(r.selected,pair(3));assert.equal(r.fallbackUsed,true);
});
test('missing, stale, future and identity-mismatched evidence never qualifies',()=>{
 for(const mutate of [p=>null,p=>({...p,checkedAt:new Date(now-300000).toISOString()}),p=>({...p,checkedAt:new Date(now+1).toISOString()}),p=>({...p,model:'other'})]){const f=fixture();assert.equal(decide({...f,capabilities:(c,m)=>mutate(f.capabilities(c,m))}).selected,null);}
 assert.equal(decide({...fixture(),availability:()=>null}).selected,null);
});
test('paid and unknown-cost providers require explicit approval',()=>{
 const f=fixture();assert.equal(decide({...f,costPolicy:()=> 'paid'}).selected,null);assert.equal(decide({...f,costPolicy:()=> 'unknown'}).selected,null);
 assert.deepEqual(decide({...f,costPolicy:()=> 'paid',approvePaid:()=>true}).selected,pair(1));
});
test('document extraction is independently required and never inferred from vision',()=>{
 const f=fixture();assert.equal(decide({...f,request:{hasDocuments:true}}).candidates[0].reason,'document-pipeline-unavailable');assert.deepEqual(decide({...f,request:{hasDocuments:true},documentPipeline:()=>true}).selected,pair(1));
});
test('authorization, disabled models and unsupported adapters fail closed',()=>{
 assert.equal(decide({...fixture(),authorize:()=>false}).selected,null);const f=fixture();f.config.connections[0].enabled=false;assert.equal(decide(f).selected,null);
 const g=fixture();g.config.connections[0].adapter='unexpected';assert.equal(decide(g).selected,null);
 assert.equal(decide({config:f.config,defaultModel:pair(1)}).selected,null);
});
test('tools respect configured permission and combined image/tools remains unqualified',()=>{
 const f=fixture();f.config.connections[0].capabilities.tools=false;assert.equal(decide({...f,request:{useTools:true}}).selected,null);
 assert.equal(decide({...fixture(),request:{hasImage:true,useTools:true}}).candidates[0].reason,'image-tools-not-qualified');
});
test('bounded invalid preferences and private backend exceptions produce safe decisions',()=>{
 assert.equal(decide({...fixture(),request:null}).reason,'invalid-routing-input');
 assert.equal(decide({...fixture(),priorities:null}).reason,'invalid-routing-input');
 assert.equal(decide({...fixture(),priorities:{text:['alias']}}).reason,'invalid-priorities');
 const r=decide({...fixture(),authorize:()=>{throw Error('secret private path');}});assert(!JSON.stringify(r).includes('secret'));assert.equal(r.selected,null);
});
