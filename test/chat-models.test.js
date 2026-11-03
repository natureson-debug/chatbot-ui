'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {choices,resolve,defaultChoice}=require('../core/chat-models');
const a={id:'provider',name:'Friendly provider',model:'model:alias',enabled:true,endpoint:'secret-endpoint',credentialRef:'secret-ref',capabilities:{streaming:true},contextLimit:null};
test('catalog exposes only approved enabled chat choices and no credentials',()=>{
 const result=choices({defaultId:'provider',connections:[a,{...a,id:'disabled',enabled:false},{...a,id:'embedding',capabilities:{streaming:false}}]});assert.equal(result.length,1);assert.equal(result[0].providerName,a.name);assert.equal(result[0].model,a.model);assert(!JSON.stringify(result).includes('secret'));
});
test('routing rejects missing, disabled, mismatched and unapproved discovered models',()=>{
 const config={defaultId:'provider',connections:[a,{...a,id:'off',enabled:false}]};for(const s of [null,{}, {providerId:'off',model:a.model},{providerId:a.id,model:'arbitrary'},{providerId:'unknown',model:a.model}])assert.throws(()=>resolve(config,s));
});
test('routing captures immutable approved configuration and preserves alias',()=>{
 const config={defaultId:a.id,connections:[structuredClone(a)]};const resolved=resolve(config,{providerId:a.id,model:a.model});config.connections[0].model='changed';assert.equal(resolved.model,a.model);assert.equal(resolved.endpoint,a.endpoint);
});
test('legacy default remains backward compatible but cannot be selected when not exposed',()=>{
 const legacy={...a,id:'legacy-local',legacy:true};const config={defaultId:'legacy-local',connections:[]};assert.equal(choices(config,legacy).length,1);assert.equal(resolve(config,{providerId:legacy.id,model:a.model},legacy).legacy,true);assert.throws(()=>resolve({...config,defaultId:'other'},{providerId:legacy.id,model:a.model},legacy));
});
test('default choice is the configured model, not the first catalog entry',()=>{
 const provider={...a,models:[{id:'alpha',name:'Alpha',enabled:true,chat:true,parameters:[],defaults:{}},{id:a.model,name:'Configured default',enabled:true,chat:true,parameters:[],defaults:{}}]};
 const config={defaultId:provider.id,connections:[provider]};
 assert.deepEqual(defaultChoice(config),{providerId:provider.id,model:a.model});
 assert.deepEqual(choices(config)[0],{providerId:provider.id,providerName:a.name,model:'alpha',name:'Alpha',contextLimit:null,capabilities:{streaming:true}});
});
