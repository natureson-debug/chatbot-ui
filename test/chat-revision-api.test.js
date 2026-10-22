const { test } = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const auth = require('../auth');
const root = path.join(__dirname, '..');

function setup(t, fault) {
    const db = new DatabaseSync(':memory:'); t.after(() => db.close());
    const context = { module: { exports: {} }, __dirname: root, require(name) {
        if (name === 'node:sqlite') return { DatabaseSync: function () { return db; } };
        if (name === './auth') return auth;
        return require(name);
    } };
    vm.runInNewContext(fs.readFileSync(path.join(root,'db.js'),'utf8'), context);
    const api = context.module.exports;
    db.exec("INSERT INTO users VALUES('u','user','unused',0),('v','other','unused',0)");
    api.createChat('a','Chat','u'); api.createChat('b','Other','v');
    const token = auth.createSession(db,'u'); let handler;
    vm.runInNewContext(fs.readFileSync(path.join(root,'server.js'),'utf8'), {
        __dirname: root, console: { error() {}, log() {} }, Buffer,
        require(name) {
            if (name === 'http') return { createServer(fn) { handler = fn; return { listen() {} }; } };
            if (name === './db') return api;
            if (name === './auth') return { ...auth, getSessionUser(...args) { if (fault) fault(db); return auth.getSessionUser(...args); } };
            if (name.startsWith('./core/')) return {};
            if (name === 'fs') return new Proxy({}, { get() { throw Error('Filesystem access prohibited'); } });
            return require(name);
        }
    });
    function request(method, url, payload, duringBody) {
        const req = { method, url, headers: { cookie: 'chatbot_session='+token }, async *[Symbol.asyncIterator]() {
            if (duringBody) await duringBody(req);
            yield typeof payload === 'string' ? payload : JSON.stringify(payload);
        } };
        const res = { headers: {}, setHeader(k,v) { assert.equal(this.status,undefined); this.headers[k]=v; },
            writeHead(status,headers) { this.status=status; Object.assign(this.headers,headers); },
            end(body) { this.body=JSON.parse(body); } };
        return handler(req,res).then(() => res);
    }
    const post = (revision=0, duringBody, chat='a', role='user') => request('POST','/api/chats/'+chat+'/messages',{ role, content:'text', expectedRevision:revision },duringBody);
    return { db, api, token, request, post };
}
test('creation and ownership-filtered listing include revisions and preserve ordering', async t => {
    const s=setup(t); const r=await s.request('POST','/api/chats');
    assert.equal(r.status,201); assert.equal(r.body.revision,0); assert.equal(r.body.title,'New Chat');
    s.api.clearChatMessages('a','u'); const list=await s.request('GET','/api/chats');
    assert.deepEqual(list.body.map(c=>[c.id,c.revision]),[['a',1],[r.body.id,0]]);
});
test('user and assistant insertion retain exact successful response and snapshot fields', async t => {
    const s=setup(t); assert.deepEqual((await s.post()).body,{id:'1'});
    const r=await s.post(0,undefined,'a','assistant'); assert.equal(r.status,201); assert.deepEqual(r.body,{id:'2'});
    const history=await s.request('GET','/api/chats/a/messages');
    assert.equal(history.headers['X-Chat-Revision'],'0'); assert.equal(history.body.length,2);
    assert.deepEqual(history.body.map(m=>m.role),['user','assistant']);
});
test('missing and malformed revisions receive stable 400 codes', async t => {
    const s=setup(t);
    for(const revision of [undefined,null,-1,1.5,'0',Number.MAX_SAFE_INTEGER+1]) {
        const r=await s.request('POST','/api/chats/a/messages',{role:'user',content:'x',expectedRevision:revision});
        assert.equal(r.status,400); assert.equal(r.body.code,revision===undefined?'EXPECTED_REVISION_REQUIRED':'INVALID_REVISION');
    }
    assert.equal((await s.request('POST','/api/chats/a/messages','{')).status,400);
    assert.equal(s.api.getMessages('a','u').length,0);
});
test('clear returns committed revision; stale conflicts and fresh messages succeed', async t => {
    const s=setup(t); await s.post();
    const clear=await s.request('DELETE','/api/chats/a/messages'); assert.deepEqual(clear.body,{deletedMessages:1,revision:1});
    const r=await s.post(); assert.equal(r.status,409);
    assert.deepEqual(r.body,{error:'Conversation was cleared; reload before sending.',code:'CHAT_REVISION_CONFLICT',currentRevision:1});
    assert.equal((await s.post(1)).status,201);
    const history=await s.request('GET','/api/chats/a/messages'); assert.equal(history.headers['X-Chat-Revision'],'1'); assert.equal(history.body.length,1);
});
test('deferred body clear/insert ordering rejects stale save; reverse ordering removes committed save', async t => {
    const s=setup(t);
    assert.equal((await s.post(0,()=>s.request('DELETE','/api/chats/a/messages'))).status,409);
    await s.post(1); await s.request('DELETE','/api/chats/a/messages'); assert.equal(s.api.getMessages('a','u').length,0);
});
test('deleted and unowned chats return 404 without revision disclosure', async t => {
    const s=setup(t); s.api.clearChatMessages('b','v'); s.api.deleteChat('a','u');
    for(const id of ['a','b']) for(const method of ['GET','POST','DELETE']) {
        const r=await s.request(method,'/api/chats/'+id+'/messages',{role:'user',content:'x',expectedRevision:0});
        assert.equal(r.status,404); assert.equal(r.body.currentRevision,undefined); assert.equal(r.headers['X-Chat-Revision'],undefined);
    }
});
for(const mode of ['logout','expiration','replacement']) test(mode+' during parsing rejects original session',async t=>{
    const s=setup(t); const r=await s.post(0,async req=>{
        if(mode==='expiration') s.db.exec('UPDATE sessions SET expires_at=0');
        else { auth.deleteSession(s.db,s.token); if(mode==='replacement') req.headers.cookie='chatbot_session='+auth.createSession(s.db,'u'); }
    });
    assert.equal(r.status,401); assert.equal(s.api.getMessages('a','u').length,0);
});
test('final authentication is inside transaction and database failures return 500', async t=>{
    let calls=0; const s=setup(t,db=>{ calls++; if(calls===2){ assert.equal(db.isTransaction,true); throw Error('database failure'); } });
    const r=await s.post(); assert.equal(r.status,500); assert.equal(s.db.isTransaction,false); assert.equal(s.api.getMessages('a','u').length,0);
});
test('initial authentication database failure returns 500, not revoked-session response',async t=>{
    const s=setup(t,()=>{throw Error('database failure')}); assert.equal((await s.post()).status,500);
});
test('insertion failure rolls back and is not a conflict',async t=>{
    const s=setup(t); s.db.exec("CREATE TRIGGER fail BEFORE INSERT ON messages BEGIN SELECT RAISE(ABORT,'failure'); END");
    const r=await s.post(); assert.equal(r.status,500); assert.equal(r.body.code,undefined); assert.equal(s.db.isTransaction,false);
});
test('concurrent valid requests both succeed; committed message survives later logout',async t=>{
    const s=setup(t); const responses=await Promise.all([s.post(),s.post()]); assert.deepEqual(responses.map(r=>r.status),[201,201]);
    auth.deleteSession(s.db,s.token); assert.equal(s.api.getMessages('a','u').length,2);
});
