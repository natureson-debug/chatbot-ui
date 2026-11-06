'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {inspectAttachmentStorage:inspect,ancestors}=require('../core/attachment-security-preflight');
const target='C:\\fixture\\attachments';
function fixture(){return ancestors(target).map(path=>({path,state:'existing',directory:true,reparse:false,ownerSid:'S-1-5-21-123',sddl:'fixture-dacl',principalsResolved:true,aces:[]}));}
const safe=item=>({path:item.path,sddl:item.sddl,complete:true,identitiesComplete:true,groupsComplete:true,ownerTrusted:true,unrelated:{write:false,delete:false,deleteChild:false,writeDac:false,writeOwner:false,replace:false}});
async function run(edit=()=>{},assess=safe){const records=fixture();edit(records);return inspect(target,{collect:async()=>records,assessEffectiveAccess:assess});}
test('simulated protected per-user tree requires complete effective-access proof',async()=>assert.equal((await run()).status,'STORAGE_ROOT_QUALIFIED'));
test('confirmed Authenticated Users effective Modify is unsafe',async()=>assert.equal((await run(()=>{},item=>({...safe(item),unrelated:{...safe(item).unrelated,write:true,delete:true}}))).status,'STORAGE_ROOT_UNSAFE'));
test('effective writable ancestor blocks otherwise protected root',async()=>assert.equal((await run(()=>{},item=>({...safe(item),unrelated:{...safe(item).unrelated,replace:item.path==='C:\\fixture'}}))).status,'STORAGE_ROOT_UNSAFE'));
test('junction or symlink evidence is unsafe',async()=>assert.equal((await run(r=>r[1].reparse=true)).status,'STORAGE_ROOT_UNSAFE'));
test('unreadable ancestor ACL is unverified',async()=>assert.equal((await run(r=>r[0].state='unverified')).status,'SECURITY_UNVERIFIED'));
test('nonexistent root reports first missing path without qualification',async()=>{const r=await run(x=>x[2]={path:target,state:'missing'});assert.equal(r.status,'SECURITY_UNVERIFIED');assert.equal(r.firstMissing,target);});
test('unknown principal and incomplete group coverage remain unverified',async()=>{assert.equal((await run(r=>r[1].principalsResolved=false)).status,'SECURITY_UNVERIFIED');assert.equal((await run(()=>{},item=>({...safe(item),groupsComplete:false}))).status,'SECURITY_UNVERIFIED');});
test('DACL alone is never treated as effective permission evidence',async()=>assert.equal((await inspect(target,{collect:async()=>fixture()})).status,'SECURITY_UNVERIFIED'));
test('inspection failures, malformed evidence and invalid paths fail closed',async()=>{assert.equal((await inspect(target,{collect:async()=>{throw Error('sensitive');}})).status,'SECURITY_UNVERIFIED');assert.equal((await inspect(target,{collect:async()=>[]})).status,'SECURITY_UNVERIFIED');assert.equal((await inspect('relative')).status,'SECURITY_UNVERIFIED');assert.equal((await run(()=>{},()=>({}))).status,'SECURITY_UNVERIFIED');});
