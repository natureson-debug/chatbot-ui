'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
function load(env={}){
 const source=fs.readFileSync('core/paths.js','utf8');
 const module={exports:{}};
 vm.runInNewContext(source,{module,process:{platform:'win32',env},require(id){if(id==='path')return require('node:path');if(id==='os')return require('node:os');throw Error('unexpected require '+id);}});
 return module.exports;
}
test('default llama executable remains the legacy install path',()=>{
 assert.equal(load({}).LLAMA_EXECUTABLE,'C:\\AI\\llama.cpp\\llama-server.exe');
});
test('explicit executable override resolves the production staged path',()=>{
 const result=load({CHATBOT_LLAMA_EXECUTABLE:'C:\\Users\\Admin\\Downloads\\Chatbot-upgrade-17E2-20261015\\llama-b11609-cuda12.4\\llama-server.exe'});
 assert.equal(result.LLAMA_EXECUTABLE,'C:\\Users\\Admin\\Downloads\\Chatbot-upgrade-17E2-20261015\\llama-b11609-cuda12.4\\llama-server.exe');
});
