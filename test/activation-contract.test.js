const test = require('node:test');
const assert = require('node:assert/strict');
const { createActivationContract } = require('./support/activation-contract.cjs');
const digest = 'a'.repeat(64), handle = {};
const request = { operationId: 'operation-1', expectedRevision: 2, profileDigest: digest };
function setup() {
    let time = 100;
    const contract = createActivationContract({ mode: 'TEST', now: () => time });
    const evidence = { at: 100, authenticatedAdmin: true, sessionValid: true, channelVerified: true,
        lockHeld: true, operationId: request.operationId, revision: 2, profileDigest: digest,
        qualified: true, retainedHandle: handle, identityVerified: true, owned: true, foreignListener: false,
        exited: true, streamsClosed: true, listenerReleased: true, listenerOwned: true, health: 'ok',
        expectedModelDigest: digest, loadedModelDigest: digest, expectedModelPath: 'approved/model.gguf',
        loadedModelPath: 'approved/model.gguf', modelApiIdentityVerified: true };
    return { contract, evidence, advance: n => time = n };
}
test('TEST only; simulated accepted contract is explicitly not production readiness', () => {
    assert.throws(() => createActivationContract({ mode: 'PRODUCTION', now: Date.now }));
    const {contract,evidence} = setup();
    assert.equal(contract.validateRequest(request,evidence).allowed,true);
    assert.equal(contract.validateReplacement(evidence,handle).allowed,true);
    assert.equal(contract.validateCompletion(request,evidence,handle,300100).allowed,true);
    assert.equal(contract.validateRequest(request,evidence).productionReady,false);
});
for (const [name, patch, code] of [
    ['concurrent lock contender',{lockHeld:false},'OPERATION_CONFLICT'],
    ['other operation',{operationId:'operation-2'},'OPERATION_CONFLICT'],
    ['replay',{replayed:true},'OPERATION_CONFLICT'],
    ['stale configuration',{revision:3},'STALE_CONFIGURATION'],
    ['changed profile',{profileDigest:'b'.repeat(64)},'STALE_CONFIGURATION'],
    ['external backend',{owned:false},'OWNERSHIP_BLOCKED'],
    ['lost ownership',{retainedHandle:null},'OWNERSHIP_BLOCKED'],
    ['foreign listener',{foreignListener:true},'OWNERSHIP_BLOCKED'],
    ['revoked administrator',{sessionValid:false},'UNAUTHORIZED'],
    ['unqualified profile',{qualified:false},'UNQUALIFIED_PROFILE'],
    ['future observation',{at:101},'STALE_EVIDENCE']
]) test(name,()=>{const {contract,evidence}=setup();assert.equal(contract.validateRequest(request,{...evidence,...patch}).code,code)});
test('partial shutdown never permits replacement',()=>{
    const {contract,evidence}=setup();
    for(const field of ['exited','streamsClosed','listenerReleased']) assert.equal(contract.validateReplacement({...evidence,[field]:false},handle).code,'SHUTDOWN_INCOMPLETE');
    assert.equal(contract.validateReplacement(evidence,{}).code,'OWNERSHIP_BLOCKED');
});
test('startup failure, model mismatch and lost handle do not complete activation',()=>{
    const {contract,evidence,advance}=setup();
    assert.equal(contract.validateCompletion(request,{...evidence,health:'unavailable'},handle,1000).code,'STARTUP_FAILED');
    for(const patch of [{loadedModelPath:'other.gguf'},{loadedModelDigest:'b'.repeat(64)},{modelApiIdentityVerified:false}])
        assert.equal(contract.validateCompletion(request,{...evidence,...patch},handle,1000).code,'MODEL_MISMATCH');
    assert.equal(contract.validateCompletion(request,evidence,{},1000).code,'OWNERSHIP_BLOCKED');
    advance(1000);assert.equal(contract.validateCompletion(request,evidence,handle,1000).code,'STARTUP_TIMEOUT');
});
test('partial recovery cannot report original requested revision as activated',()=>{
    const {contract,evidence}=setup();
    assert.equal(contract.validateCompletion(request,{...evidence,revision:1},handle,1000).code,'STALE_CONFIGURATION');
    const output=contract.validateRequest(request,{...evidence,secret:'DO_NOT_LOG',sessionValid:false});
    assert.ok(!JSON.stringify(output).includes('DO_NOT_LOG'));
});
