'use strict';
// Explicit opt-in integration experiment; never part of the application's startup.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const net = require('node:net');
const assert = require('node:assert/strict');
const {spawn, spawnSync} = require('node:child_process');

if (process.argv[2] !== '--run-harmless-fixtures') {
    console.log('SKIP: native broker fixtures require explicit --run-harmless-fixtures');
    process.exit(0);
}
if(process.platform !== 'win32' || process.arch !== 'x64')throw Error('x64 Windows required');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chatbot-native-broker-'));
const build = path.join(root, 'build'); fs.mkdirSync(build);
const fixture = path.join(build, 'fixture.exe');
const broker = path.join(build, 'broker.exe');
const lease = path.join(build, 'fixture.test-lease');
const hash = p => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const results = [], sessions = [], ports = new Set(), childPids = new Set();
function record(name, detail = {}) { results.push({name, detail, status:'PASS'}); console.log('PASS: ' + name); }
function verifyHandles(s,r) {
    assert.equal(r.ownedHandles,0,'broker-owned HANDLE leak');
    if(r.handles!==s.hello.handles){
        let item=results.find(r=>r.name==='total process handle baseline');
        if(!item){item={name:'total process handle baseline',status:'UNVERIFIED',observations:[]};results.push(item);}
        item.observations.push({before:s.hello.handles,after:r.handles});
    }
}
function compile(source, target) {
    const vc = 'C:\\Program Files (x86)\\Microsoft Visual Studio\\2022\\BuildTools\\VC\\Auxiliary\\Build\\vcvarsall.bat';
    const script = path.join(root, 'build.cmd');
    fs.writeFileSync(script, [
        '@echo off', `call "${vc}" x64 10.0.22621.0`, 'if errorlevel 1 exit /b 1',
        'where cl', 'where link', 'set WindowsSDKVersion', 'set VCToolsVersion',
        `cl /std:c++17 /EHsc /W4 /WX /utf-8 /MT /D_WIN32_WINNT=0x0A00 /I"${__dirname}" /I"${build}" /Fo"${target}.obj" /Fe"${target}" "${path.join(__dirname, source)}" /link /MACHINE:X64 /DYNAMICBASE /NXCOMPAT kernel32.lib advapi32.lib bcrypt.lib iphlpapi.lib ws2_32.lib`,
        'exit /b %errorlevel%', ''
    ].join('\r\n'));
    const r = spawnSync(process.env.ComSpec, ['/d','/c',script], {cwd:build, windowsHide:true, encoding:'utf8', timeout:60000});
    const log = (r.stdout || '') + (r.stderr || '');
    fs.writeFileSync(path.join(root, source + '.build.log'), log);
    if (r.error || r.status !== 0) throw Error('Build failed: ' + log);
    const bytes=fs.readFileSync(target), pe=bytes.readUInt32LE(0x3c);
    assert.equal(bytes.readUInt16LE(pe+4),0x8664);
}
function within(promise, ms, label) {
    let timer;
    return Promise.race([promise,new Promise((_,reject)=>timer=setTimeout(()=>reject(Error(label+' timeout')),ms))]).finally(()=>clearTimeout(timer));
}
async function open() {
    const p=spawn(broker,['--test-only'],{cwd:build,shell:false,detached:false,windowsHide:true,stdio:['pipe','pipe','pipe']});
    let buffer='',pending=[],queue=[],done=false;
    const closed=new Promise((resolve,reject)=>{p.once('error',reject);p.once('close',code=>{done=true;resolve(code);while(pending.length)pending.shift().reject(Error('broker closed'));});});
    p.stdin.on('error',()=>{});
    p.stderr.on('data',()=>{throw Error('Unexpected broker stderr');});
    p.stdout.on('data',chunk=>{
        buffer+=chunk.toString('utf8'); assert.ok(buffer.length<65536);
        while(buffer.includes('\n')) {
            const i=buffer.indexOf('\n'), line=JSON.parse(buffer.slice(0,i)); buffer=buffer.slice(i+1);
            if(pending.length)pending.shift().resolve(line); else queue.push(line);
        }
    });
    const next=()=>within(queue.length?Promise.resolve(queue.shift()):new Promise((resolve,reject)=>pending.push({resolve,reject})),7000,'control response');
    const s={p,closed,next,done:()=>done,sequence:1,hello:null,
        async raw(line){p.stdin.write(line+'\n');const r=await next();if(r.nextSequence)this.sequence=r.nextSequence;return r;},
        async request(command){return this.raw(`V1 ${this.sequence} ${this.hello.token} ${command}`);},
        async quit(){p.stdin.end(`V1 ${this.sequence} ${this.hello.token} QUIT\n`);return within(closed,5000,'broker exit');}
    };
    sessions.push(s); s.hello=await next(); assert.equal(s.hello.status,'hello'); assert.equal(s.hello.nonElevated,true); return s;
}
async function launch(s,mode='cooperative') {
    const r=await s.request('START '+mode); assert.equal(r.status,'started');
    assert.equal(r.identityVerified,true);assert.equal(r.contained,true);assert.equal(r.argumentsVerified,true);
    assert.match(r.creationTime,/^\d+$/);assert.ok(r.pid>0);assert.ok(r.port!==8080&&r.port!==18080);
    ports.add(r.port);childPids.add(r.pid);return r;
}
async function portFree(port) {
    await within(new Promise((resolve,reject)=>{
        const s=net.createServer();s.once('error',reject);s.listen({host:'127.0.0.1',port,exclusive:true},()=>s.close(resolve));
    }),1000,'listener release');
}
async function eventuallyFree(port) {
    const deadline=Date.now()+5000;
    while(true){try{await portFree(port);return;}catch(e){if(Date.now()>=deadline)throw e;await new Promise(r=>setTimeout(r,20));}}
}
function removeVerifiedLease() {
    // Harness-only cleanup after the broker exited and every observed fixture port is free.
    assert.equal(path.dirname(lease),build);
    if(fs.existsSync(lease)) fs.unlinkSync(lease);
}
async function suite() {
    compile('fixture.cpp',fixture);
    fs.writeFileSync(path.join(build,'fixture-pin.h'),`#pragma once\n#define FIXTURE_PATH L${JSON.stringify(fixture)}\n#define FIXTURE_SHA256 "${hash(fixture)}"\n`);
    compile('broker.cpp',broker);
    record('x64 compiler, SDK headers/libraries and Job List compilation');
    fs.writeFileSync(path.join(root,'manifest.json'),JSON.stringify({fixture:hash(fixture),broker:hash(broker)},null,2));

    const a=await open(); const first=await launch(a);
    record('non-elevated, original-handle identity and creation-time containment',first);
    record('Unicode and Windows argument quoting verified by fixture');
    assert.equal((await a.request('OBSERVE')).status,'owned'); record('same-handle re-observation and listener ownership');
    assert.equal((await a.request('START cooperative')).status,'duplicate-launch-rejected'); record('duplicate launch rejected');
    assert.equal((await a.request('ADOPT 1234')).status,'rejected');
    assert.equal((await a.request('TERMINATE 1234')).status,'rejected'); record('no PID adoption or arbitrary termination API');
    assert.equal((await a.request('FORCE')).status,'rejected'); record('forced stop requires explicit authorization');
    const b=await open();
    assert.equal((await b.raw(`V1 1 ${a.hello.token} FORCE AUTHORIZE`)).status,'rejected');
    assert.equal((await a.request('OBSERVE')).status,'owned'); record('cross-session capability isolation');
    assert.equal((await b.request('START cooperative')).status,'blocked');assert.equal(await b.closed,91);
    assert.equal((await a.request('OBSERVE')).status,'owned'); record('two-process exclusive fixture lease');
    const seq=a.sequence;
    assert.equal((await a.raw(`V1 ${seq-1} ${a.hello.token} STOP`)).status,'rejected');
    assert.equal((await a.raw(`V2 ${seq} ${a.hello.token} STOP`)).status,'rejected');
    assert.equal((await a.request('OBSERVE extra')).status,'rejected'); record('replay, version and invalid command rejection');
    const stopped=await a.request('STOP');assert.equal(stopped.status,'cooperative-complete');assert.equal(stopped.exitCode,0);
    assert.equal(stopped.streamsClosed,true);assert.equal(stopped.listenerReleased,true);
    assert.equal((await a.request('START cooperative')).status,'duplicate-launch-rejected');
    verifyHandles(a,stopped);await portFree(first.port);assert.equal(await a.quit(),0);
    assert.equal(fs.existsSync(lease),false);record('cooperative exit, stream closure, listener and handle cleanup');

    const c=await open(), second=await launch(c,'ignore');
    assert.equal((await c.request('STOP')).status,'incomplete');
    assert.equal((await c.request('START cooperative')).status,'duplicate-launch-rejected');
    assert.equal((await c.request('OBSERVE')).status,'owned'); record('incomplete shutdown preserves ownership and rejects replacement');
    const forced=await c.request('FORCE AUTHORIZE');assert.equal(forced.status,'forced-complete');assert.equal(forced.exitCode,77);
    verifyHandles(c,forced);await portFree(second.port);await c.quit();record('authorized forced exit through original handle');

    const d=await open(), third=await launch(d,'ignore');
    d.p.stdin.write(`V1 ${d.sequence} ${d.hello.token} CRASH_TEST\n`);
    assert.equal(await within(d.closed,5000,'crash'),86);await eventuallyFree(third.port);assert.equal(fs.existsSync(lease),true);
    const e=await open();assert.equal((await e.request('START cooperative')).status,'blocked');assert.equal(await e.closed,91);
    record('helper crash kills contained fixture; stale lease blocks takeover');removeVerifiedLease();

    const f=await open(), fourth=await launch(f,'ignore');f.p.stdin.end();assert.equal(await within(f.closed,6000,'disconnect'),0);
    await eventuallyFree(fourth.port);assert.equal(fs.existsSync(lease),true);record('supervisor disconnect cleanup, no automatic restart');removeVerifiedLease();

    const lost=await open(), lostChild=await launch(lost,'ignore');
    assert.equal((await lost.request('LOSE_HANDLE_TEST')).status,'blocked');assert.equal(await lost.closed,91);
    await eventuallyFree(lostChild.port);assert.equal(fs.existsSync(lease),true);removeVerifiedLease();
    record('handle loss blocks control; containment cleans up without PID adoption');

    const foreign=await open(), foreignChild=await launch(foreign,'ignore');
    const other=net.createServer();
    await new Promise((resolve,reject)=>{other.once('error',reject);other.listen({host:'::1',port:foreignChild.port,ipv6Only:true},resolve);});
    try {
        assert.equal((await foreign.request('OBSERVE')).status,'blocked');assert.equal(await foreign.closed,91);
        assert.equal(other.listening,true); // The unrelated listener must never be terminated.
    } finally {await new Promise(resolve=>other.close(resolve));}
    await eventuallyFree(foreignChild.port);removeVerifiedLease();record('foreign IPv6 listener blocks; unrelated listener survives');

    const stalled=await open(), stalledChild=await launch(stalled,'ignore');
    stalled.p.stdout.pause();
    const exited=new Promise(resolve=>stalled.p.once('exit',resolve));
    // Fill the outbound pipe with bounded rejection replies without reading it.
    stalled.p.stdin.write(('V1 0 invalid OBSERVE\n').repeat(12000));
    const exitCode=await within(exited,10000,'stalled control writer');
    stalled.p.stdout.resume();await within(stalled.closed,3000,'stalled stream closure');
    assert.ok([91,92].includes(exitCode));await eventuallyFree(stalledChild.port);removeVerifiedLease();
    record('unresponsive supervisor cannot cause an unbounded control write');

    const g=await open();assert.equal((await g.raw('X'.repeat(257))).status,'blocked');assert.equal(await g.closed,91);record('bounded control frame rejection');
    // Image mismatch is detected before CreateProcessW, not by adopting an observed PID.
    const original=fs.readFileSync(fixture);fs.appendFileSync(fixture,'tampered-test');
    try {
        // Warm-up integrity verification can reject before the handshake.
        const p=spawn(broker,['--test-only'],{cwd:build,shell:false,windowsHide:true,stdio:['pipe','pipe','pipe']});
        let response='';p.stdout.on('data',b=>response+=b);p.stderr.resume();p.stdin.end();
        assert.equal(await within(new Promise((resolve,reject)=>{p.once('error',reject);p.once('close',resolve);}),5000,'tampered image'),91);
        assert.equal(JSON.parse(response).status,'blocked');
    }
    finally {fs.writeFileSync(fixture,original);}
    record('fixed fixture SHA-256 allowlist rejects modified image');
    for(let i=0;i<3;++i){const s=await open(),r=await launch(s);const stop=await s.request('STOP');assert.equal(stop.status,'cooperative-complete');verifyHandles(s,stop);await s.quit();await portFree(r.port);}
    record('repeated separate sessions close all explicitly owned HANDLEs');
}
(async()=>{
    let failure=null;
    try{await suite();}catch(e){failure=e;console.error(e.message);}
    finally{
        for(const s of sessions)if(!s.done())s.p.stdin.end();
        try {
            await Promise.all(sessions.map(s=>within(s.closed,7000,'final broker cleanup')));
            for(const port of ports)await eventuallyFree(port);
            // Read-only existence checks, never a PID-based termination.
            for(const pid of childPids){let alive=false;try{process.kill(pid,0);alive=true;}catch(e){if(e.code!=='ESRCH')throw e;}assert.equal(alive,false,'fixture PID still present or reused; manual review required');}
            removeVerifiedLease();record('all broker pipes closed, fixture PIDs absent and ports released');
        }catch(e){failure??=e;console.error('Cleanup incomplete: '+e.message);}
        const report={root,operator:os.userInfo().username,architecture:process.arch,results,failure:failure?.message??null};fs.writeFileSync(path.join(root,'results.json'),JSON.stringify(report,null,2));
        console.log(JSON.stringify({root,passed:results.filter(r=>r.status==='PASS').length,unverified:results.filter(r=>r.status==='UNVERIFIED').length,failure:report.failure}));
        if(failure)process.exitCode=1;
        else if(results.some(r=>r.status==='UNVERIFIED'))process.exitCode=2;
    }
})();
