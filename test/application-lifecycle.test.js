'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),http=require('node:http');
const {EventEmitter}=require('node:events');
const {DatabaseSync}=require('node:sqlite');
const {createRequestTracker}=require('../core/request-tracker');
const {withHttpErrorBoundary}=require('../core/http-error-boundary');
const {installApplicationLifecycle}=require('../core/application-lifecycle');
function deferred(){let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};}
async function setup(t, handler, broken=false){
 const db=new DatabaseSync(':memory:');db.exec('CREATE TABLE example(value TEXT)');const tracker=createRequestTracker();
 const server=http.createServer(withHttpErrorBoundary(tracker.track((q,r)=>handler(q,r,db))));
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const signals=new EventEmitter();let closes=0;
 const options={server,requestTracker:tracker,signals,report(){},timeoutMs:70,gracePeriodMs:20,cleanupTimeoutMs:20,
 db:{close(){closes++;assert.equal(tracker.getActiveCount(),0);assert.equal(server.listening,false);if(broken)throw Error('synthetic');db.close();}}};
 const life=installApplicationLifecycle(options);
 t.after(async()=>{server.closeAllConnections();if(server.listening)await new Promise(r=>server.close(r));try{db.close()}catch{}});
 return {db,server,tracker,signals,life,options,closes:()=>closes};
}
function request(s){return new Promise((resolve,reject)=>{http.get({host:'127.0.0.1',port:s.address().port,agent:false},r=>{r.resume();r.on('end',resolve)}).on('error',reject)});}
test('real HTTP and SQLite: request finishes before close; signal registration and shutdown are idempotent',async t=>{
 const entered=deferred(),release=deferred();const f=await setup(t,async(q,r,db)=>{entered.resolve();await release.promise;db.prepare('INSERT INTO example VALUES (?)').run('synthetic');r.end('ok');});
 const pending=request(f.server);await entered.promise;
 assert.equal(installApplicationLifecycle(f.options),f.life);assert.equal(f.signals.listenerCount('SIGINT'),1);
 f.signals.emit('SIGINT');f.signals.emit('SIGTERM');assert.equal(f.closes(),0);release.resolve();await pending;
 const result=await f.life.shutdown();assert.equal(result.databaseClosed,true);assert.equal(f.closes(),1);assert.throws(()=>f.db.prepare('SELECT 1'));
});
test('disconnected stalled handler prevents SQLite closure even after deadline',async t=>{
 const entered=deferred(),release=deferred();const f=await setup(t,async(q,r)=>{entered.resolve();await release.promise;if(!r.destroyed)r.end();});
 const req=http.get({host:'127.0.0.1',port:f.server.address().port},r=>r.resume());req.on('error',()=>{});await entered.promise;req.destroy();
 const result=await f.life.shutdown();assert.equal(result.completed,false);assert.equal(f.closes(),0);assert.equal(f.signals.exitCode,1);
 assert.equal(f.db.prepare('SELECT 1 AS n').get().n,1);release.resolve();await new Promise(setImmediate);
 assert.equal((await f.life.shutdown()).completed,false);assert.equal(f.closes(),0);
});
test('database closure failure reported once without unhandled rejection',async t=>{
 const f=await setup(t,(q,r)=>r.end('ok'),true);await request(f.server);
 assert.equal((await f.life.shutdown()).completed,false);await f.life.shutdown();assert.equal(f.closes(),1);assert.equal(f.signals.exitCode,1);
});
