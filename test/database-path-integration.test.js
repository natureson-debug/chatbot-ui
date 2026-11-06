'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {databasePath,initializeDatabase,openExistingDatabase}=require('../core/database-startup');
test('normal startup never imports legacy data into an empty per-user directory',t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'db-no-fallback-'));
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const installation=path.join(root,'installation'),portable=path.join(root,'portable');
 fs.mkdirSync(path.join(installation,'data'),{recursive:true});fs.mkdirSync(portable);
 const legacy=databasePath(installation);initializeDatabase(legacy);
 const before=fs.readFileSync(legacy);
 const env={CHATBOT_STORAGE_MODE:'per-user',CHATBOT_DATA_ROOT:portable};
 const selected=databasePath(installation,{env});let opens=0;
 const source=fs.readFileSync(path.join(__dirname,'../db.js'),'utf8');
 assert.throws(()=>require('node:vm').runInNewContext(source,{
  __dirname:installation,process:{env},require(id){
   assert.equal(id,'./core/database-startup');
   return {databasePath,openExistingDatabase(file){opens++;assert.equal(file,selected);return openExistingDatabase(file);}};
  }
 }),{code:'DB_STARTUP_FAILED'});
 assert.equal(opens,1);assert.deepEqual(fs.readdirSync(portable),[]);
 assert.deepEqual(fs.readFileSync(legacy),before);assert(!fs.existsSync(selected));
});
test('legacy and installation defaults retain existing database locations',()=>{
 assert.equal(databasePath('C:\\AI\\chatbot-ui',{platform:'win32',env:{}}),'C:\\AI\\chatbot-ui\\data\\chatbot.db');
 assert.equal(databasePath('/opt/chatbot',{platform:'linux',env:{}}),'/opt/chatbot/data/chatbot.db');
 assert.equal(databasePath('/Applications/Chatbot',{platform:'darwin',env:{}}),'/Applications/Chatbot/data/chatbot.db');
});
test('per-user selection and absolute database override are explicit',()=>{
 const options={platform:'linux',home:'/home/test',env:{CHATBOT_STORAGE_MODE:'per-user',CHATBOT_DATA_ROOT:'/tmp/fixture-data'}};
 assert.equal(databasePath('/opt/app',options),'/tmp/fixture-data/data/chatbot.db');
 options.env.CHATBOT_DB_PATH='/tmp/other.db';
 assert.equal(databasePath('/opt/app',options),'/tmp/other.db');
});
test('invalid modes, relative overrides and conflicting roots fail without fallback',()=>{
 for(const env of [{CHATBOT_STORAGE_MODE:''},{CHATBOT_DB_PATH:'relative.db'},{CHATBOT_DB_PATH:''},{CHATBOT_DATA_ROOT:'/one',CHATBOT_HOME:'/two'}]){
  assert.throws(()=>databasePath('/opt/app',{platform:'linux',env}),{code:'APP_DATA_PATH_INVALID'});
 }
});
test('selected missing database is never created; intentional initialization is exclusive',t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'db-path-integration-'));
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const file=databasePath(root,{env:{CHATBOT_STORAGE_MODE:'per-user',CHATBOT_DATA_ROOT:root}});
 assert.equal(file,path.join(root,'data','chatbot.db'));
 assert.throws(()=>openExistingDatabase(file),{code:'DB_STARTUP_FAILED'});
 assert.deepEqual(fs.readdirSync(root),[]);
 fs.mkdirSync(path.dirname(file));initializeDatabase(file);
 const db=openExistingDatabase(file);assert.equal(db.prepare('PRAGMA quick_check').get().quick_check,'ok');db.close();
 assert.throws(()=>initializeDatabase(file),{code:'DB_INITIALIZATION_FAILED'});
 assert.deepEqual(fs.readdirSync(root),['data']);
});
