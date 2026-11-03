'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
function load(env={}){
 const source=fs.readFileSync('core/config.js','utf8');
 const module={exports:{}};
 vm.runInNewContext(source,{module,process:{env},require(name){if(name==='./paths')return {API_KEY_FILE:'key',AI_CONFIG_FILE:'config',MODELS_DIR:'models'};throw Error('Unexpected require: '+name);}});
 return module.exports;
}
test('default port remains 3000 when CHATBOT_PORT is absent',()=>{assert.equal(load({}).PORT,3000);assert.equal(load({CHATBOT_PORT:''}).PORT,3000);});
test('CHATBOT_PORT accepts validated custom loopback ports',()=>{assert.equal(load({CHATBOT_PORT:'4173'}).PORT,4173);assert.equal(load({CHATBOT_PORT:'1'}).PORT,1);assert.equal(load({CHATBOT_PORT:'65535'}).PORT,65535);});
test('invalid CHATBOT_PORT values fail explicitly',()=>{for(const value of ['0','65536','-1','abc','1.5','NaN','80 80']){assert.throws(()=>load({CHATBOT_PORT:value}),/CHATBOT_PORT/);}});
