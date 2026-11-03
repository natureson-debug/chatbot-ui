'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{EventEmitter}=require('node:events'),{PassThrough}=require('node:stream');
const {publicAddress,pinnedAddress,createCloudFetch}=require('../core/cloud-transport');
test('cloud address rules reject internal/metadata/mapped and reserved IP ranges',()=>{
 for(const ip of ['127.0.0.1','10.1.2.3','169.254.169.254','100.64.0.1','::1','::ffff:127.0.0.1','fc00::1','fe80::1','224.1.1.1','0.0.0.0'])assert.equal(publicAddress(ip),false,ip);
 assert.equal(publicAddress('8.8.8.8'),true);assert.equal(publicAddress('2606:4700:4700::1111'),true);
});
test('mixed DNS answers fail closed and explicit private approval never permits metadata',async()=>{
 const url=new URL('https://fixture.invalid/v1');await assert.rejects(pinnedAddress(url,async()=>[{address:'8.8.8.8',family:4},{address:'127.0.0.1',family:4}]));
 await assert.rejects(pinnedAddress(url,async()=>[{address:'169.254.169.254',family:4}],null,{allowPrivate:true}));
 assert.equal((await pinnedAddress(url,async()=>[{address:'10.1.2.3',family:4}],null,{allowPrivate:true})).address,'10.1.2.3');
});
function fixture(status=200){let dnsCalls=0,connections=0,pinned,requestHost;const fetch=createCloudFetch({lookup:async()=>{dnsCalls++;return [{address:dnsCalls===1?'8.8.8.8':'127.0.0.1',family:4}];},request:(url,options,callback)=>{
 connections++;requestHost=url.hostname;options.lookup(url.hostname,{all:true},(_error,entries)=>pinned=entries[0].address);const req=new EventEmitter();req.destroy=()=>{};req.end=()=>{const r=new PassThrough();r.statusCode=status;r.headers={};callback(r);r.end('fixture');};return req;
 }});return{fetch,result:()=>({dnsCalls,connections,pinned,requestHost})};}
test('validated address is pinned while original TLS hostname is retained',async()=>{const f=fixture();assert.equal(await(await f.fetch('https://fixture.invalid/v1')).text(),'fixture');assert.deepEqual(f.result(),{dnsCalls:1,connections:1,pinned:'8.8.8.8',requestHost:'fixture.invalid'});await assert.rejects(f.fetch('https://fixture.invalid/v1'));assert.equal(f.result().connections,1);});
test('redirects never follow; HTTP and URL credentials rejected',async()=>{const f=fixture(302);await assert.rejects(f.fetch('https://fixture.invalid/v1'),/redirect/);assert.equal(f.result().connections,1);await assert.rejects(f.fetch('http://fixture.invalid/v1'));await assert.rejects(f.fetch('https://user:password@fixture.invalid/v1'));});
test('aborted request cannot open a socket and DNS waiting is cancellable',async()=>{
 let connections=0;const f=createCloudFetch({lookup:()=>new Promise(()=>{}),request:()=>connections++});const c=new AbortController();const pending=f('https://fixture.invalid/v1',{signal:c.signal});c.abort();await assert.rejects(pending);assert.equal(connections,0);
});

test('invalid upstream response metadata fails closed without uncaught callbacks',async()=>{
 const f=fixture(9999);await assert.rejects(f.fetch('https://fixture.invalid/v1'),/response unavailable/);
});
