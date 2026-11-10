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
        if (name === './core/database-startup') return {
            databasePath: () => ':memory:',
            openExistingDatabase() { require('../core/database-schema').initializeSchema(db); return db; }
        };
        if (name === './auth') return auth;
        return require(name);
    } };
    vm.runInNewContext(fs.readFileSync(path.join(root,'db.js'),'utf8'), context);
    const api = context.module.exports;
    db.exec("INSERT INTO users VALUES('u','user','unused',0),('v','other','unused',0)");
    api.createChat('a','Chat','u'); api.createChat('b','Other','v');
    const token = auth.createSession(db,'u'); let handler;
    vm.runInNewContext(fs.readFileSync(path.join(root,'server.js'),'utf8'), {
        __dirname: root, console: { error() {}, log() {} }, Buffer, module: { exports: {} },
        require(name) {
            if (name === 'http') return { createServer(fn) { handler = fn; return { listen() {} }; } };
            if (name === './db') return api;
            if (name === './core/session-cookie') return require('../core/session-cookie');
            if (name === './auth') return { ...auth, getSessionUser(...args) { if (fault) fault(db); return auth.getSessionUser(...args); } };
            if (name === './core/system-logs') return require('../core/system-logs');
            if (name === './core/system-log-routes') return require('../core/system-log-routes');
            if (name === './core/benchmark-runner') return {
                createBenchmarkRunner: () => ({ beginChatRequest: async () => () => {}, stop: async () => {} })
            };
            if (name === './core/benchmark-routes') return { createBenchmarkRoutes: () => () => false };
            if (name === './core/request-tracker') return { createRequestTracker: () => ({ track: handler => handler }) };
            if (name === './core/http-error-boundary') return { withHttpErrorBoundary: handler => handler };
            if (name.startsWith('./core/')) return {};
            if (name === 'fs') return new Proxy({}, { get() { throw Error('Filesystem access prohibited'); } });
            return require(name);
        }
    });
    function request(method, url, payload, duringBody, sessionToken = token) {
        const req = { method, url, headers: { cookie: 'chatbot_session='+sessionToken }, async *[Symbol.asyncIterator]() {
            if (duringBody) await duringBody(req);
            yield typeof payload === 'string' ? payload : JSON.stringify(payload);
        } };
        const res = { headers: {}, setHeader(k,v) { assert.equal(this.status,undefined); this.headers[k]=v; },
            writeHead(status,headers) { this.status=status; Object.assign(this.headers,headers); },
            end(body) { this.body=JSON.parse(body); } };
        return handler(req,res).then(() => res);
    }
    const post = (revision=0, duringBody, chat='a', role='user') => request('POST','/api/chats/'+chat+'/messages',{ role, content:'text', expectedRevision:revision },duringBody);
    return { db, api, token, request, post, handler };
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
test('real server route returns logs only to an authenticated administrator',async t=>{
    const s=setup(t);
    s.db.prepare('INSERT INTO users (id, username, password_hash, is_admin) VALUES (?, ?, ?, 1)')
        .run('admin-id','admin','unused');
    const adminToken=auth.createSession(s.db,'admin-id');
    const insert=s.db.prepare(`INSERT INTO system_events (
        event_id, occurred_at, severity, category, event_code, message, metadata_json,
        correlation_id, actor_id, provider_id, outcome
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const now=Date.now();
    insert.run('event-1',new Date(now-2000).toISOString(),'INFO','PROVIDER','PROVIDER_CONNECTION_TEST_STARTED',
        'Provider connection test started','{"diagnostic":true,"apiKey":"secret-value"}','trace-1','admin-id','provider-a','UNKNOWN');
    insert.run('event-2',new Date(now-1000).toISOString(),'WARN','PROVIDER','PROVIDER_CONNECTION_TEST_FAILED',
        'Provider connection test failed','{"reason":"operation_failed","password":"secret-value"}','trace-2','admin-id','provider-a','FAILURE');
    insert.run('event-3',new Date(now).toISOString(),'INFO','AUTH','AUTH_LOGIN_SUCCEEDED',
        'User signed in','{"password":"secret-value"}',null,'admin-id',null,'SUCCESS');

    const server=require('node:http').createServer(s.handler);
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    t.after(()=>new Promise(resolve=>server.close(resolve)));
    const port=server.address().port;
    async function send(method,url,token,payload,extraHeaders={}) {
        return new Promise((resolve,reject)=>{
            const request=require('node:http').request({
                host:'127.0.0.1',port,path:url,method,
                headers:{...(token?{cookie:`chatbot_session=${token}`}:{ }),...extraHeaders,
                    ...(payload===undefined?{}:{'content-type':'application/json'})}
            },response=>{
                let body='';response.setEncoding('utf8');
                response.on('data',chunk=>body+=chunk);
                response.on('end',()=>resolve({status:response.statusCode,headers:response.headers,
                    body:body?JSON.parse(body):null}));
            });
            request.on('error',reject);
            request.end(payload===undefined?undefined:JSON.stringify(payload));
        });
    }
    const get=(url,token,extraHeaders)=>send('GET',url,token,undefined,extraHeaders);

    assert.equal((await get('/api/admin/system-logs')).status,401);
    assert.equal((await get('/api/admin/system-logs',s.token)).status,403);
    const page=await get('/api/admin/system-logs?category=PROVIDER&page=1&pageSize=1',adminToken);
    assert.equal(page.status,200);
    assert.equal(page.headers['cache-control'],'no-store');
    assert.equal(page.body.total,2);
    assert.equal(page.body.events.length,1);
    assert.equal(page.body.events[0].eventId,'event-2');
    assert.equal(page.body.events[0].metadata.reason,'operation_failed');
    assert.equal(JSON.stringify(page.body).includes('secret-value'),false);
    const secondPage=await get('/api/admin/system-logs?providerId=provider-a&page=2&pageSize=1',adminToken);
    assert.equal(secondPage.status,200);
    assert.equal(secondPage.body.events[0].eventId,'event-1');
    assert.deepEqual(secondPage.body.events[0].metadata,{diagnostic:true});
    const redacted=await get('/api/admin/system-logs?eventCode=AUTH_LOGIN_SUCCEEDED',adminToken);
    assert.equal(redacted.body.events[0].metadata,null);

    const password='not-for-system-logs';
    s.db.prepare('INSERT INTO users (id, username, password_hash, is_admin) VALUES (?, ?, ?, 0)')
        .run('login-user', 'login-user', auth.hashPassword(password));
    s.api.createChat('chat-logging-failure','Logging failure fixture','login-user');
    const loggedLogin=await send('POST','/api/login',undefined,{username:'login-user',password},
        {'x-correlation-id':password});
    assert.equal(loggedLogin.status,200);
    await new Promise(resolve=>setImmediate(resolve));
    const loginEvent=s.db.prepare("SELECT correlation_id, metadata_json FROM system_events WHERE event_code='AUTH_LOGIN_SUCCEEDED' AND actor_id='login-user'").get();
    assert.equal(loginEvent.correlation_id,null);
    assert.equal(loginEvent.metadata_json,null);
    assert.equal(JSON.stringify(loginEvent).includes(password),false);

    s.db.exec("CREATE TRIGGER reject_system_log BEFORE INSERT ON system_events BEGIN SELECT RAISE(ABORT, 'fixture logging failure'); END");
    const login=await send('POST','/api/login',undefined,{username:'login-user',password},
        {'x-correlation-id':password});
    assert.equal(login.status,200);
    assert.equal(JSON.stringify(login.body).includes(password),false);
    const loginCookie=login.headers['set-cookie'][0].match(/chatbot_session=([0-9a-f]{64})/)[1];
    const chat=await send('POST','/api/chats/chat-logging-failure/messages',loginCookie,
        {role:'user',content:'normal chatbot operation',expectedRevision:0},
        {'x-correlation-id':loginCookie});
    assert.equal(chat.status,201);
    assert.equal(s.api.getMessages('chat-logging-failure','login-user').length,1);
    await new Promise(resolve=>setTimeout(resolve,10));
    assert.equal(s.db.prepare("SELECT COUNT(*) AS count FROM system_events WHERE event_code='AUTH_LOGIN_SUCCEEDED' AND actor_id='login-user'").get().count,1);
    s.db.exec('DROP TRIGGER reject_system_log');

    const revoked=auth.createSession(s.db,'admin-id');
    auth.deleteSession(s.db,revoked);
    assert.equal((await get('/api/admin/system-logs',revoked)).status,401);
    const expired=auth.createSession(s.db,'admin-id');
    s.db.prepare('UPDATE sessions SET expires_at=0 WHERE user_id=?').run('admin-id');
    assert.equal((await get('/api/admin/system-logs',expired)).status,401);
});
