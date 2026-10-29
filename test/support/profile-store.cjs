'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { buildLlamaLaunchSpec } = require('../../core/llama-launch');
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
function canonical(v) {
    if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
    if (v && typeof v === 'object') return '{' + Object.keys(v).sort().map(k => JSON.stringify(k)+':'+canonical(v[k])).join(',') + '}';
    return JSON.stringify(v);
}
function fail(code) { const e = new Error(code); e.code = code; throw e; }
function freeze(v) { if(v && typeof v==='object') { Object.values(v).forEach(freeze);Object.freeze(v); } return v; }
function openFixtureStore({ mode, root, approvals, integrityKey }) {
    if(mode !== 'TEST' || !Buffer.isBuffer(integrityKey) || integrityKey.length !== 32) fail('TEST_AUTHORITY_REQUIRED');
    // Only direct, existing temporary fixture directories; never import application db.js.
    const temp=fs.realpathSync(os.tmpdir()), real=fs.realpathSync(root);
    if(path.dirname(real)!==temp || !path.basename(real).startsWith('chatbot-profile-test-') || fs.lstatSync(root).isSymbolicLink()) fail('FIXTURE_ROOT_REQUIRED');
    const trusted=JSON.parse(JSON.stringify(approvals));
    const key=Buffer.from(integrityKey);
    function artifact(p, expected, directory=false) {
        if(typeof p!=='string' || !path.isAbsolute(p) || path.normalize(p)!==p || path.relative(real,p).startsWith('..') || path.isAbsolute(path.relative(real,p))) fail('INVALID_ARTIFACT_PATH');
        let current=p;
        while(current!==real){if(fs.lstatSync(current).isSymbolicLink())fail('REPARSE_REJECTED');current=path.dirname(current);}
        if(fs.realpathSync(p)!==p)fail('NONCANONICAL_PATH');
        const stat=fs.statSync(p);
        if(directory ? !stat.isDirectory() : !stat.isFile())fail('INVALID_ARTIFACT');
        if(!directory && (!/^[a-f0-9]{64}$/.test(expected||'') || hash(fs.readFileSync(p))!==expected))fail('ARTIFACT_HASH_MISMATCH');
        return p;
    }
    function profile(id) {
        if(typeof id!=='string' || !Object.hasOwn(trusted,id))fail('UNAPPROVED_PROFILE');
        const a=trusted[id], s=a.settings;
        if(a.version!==1 || typeof a.gpuIdentity!=='string' || !a.gpuIdentity)fail('INVALID_APPROVAL');
        buildLlamaLaunchSpec(s); // Pure explicit API: no config/key reads.
        if(s.host!=='127.0.0.1' || s.corsOrigin!==`http://127.0.0.1:${s.port}` || !Number.isSafeInteger(s.gpuLayers) || !Number.isSafeInteger(s.verbosity))fail('SECURITY_POLICY');
        artifact(s.executable,a.executableSha256);artifact(s.modelPath,a.modelSha256);artifact(s.cwd,null,true);
        if(!s.modelPath.toLowerCase().endsWith('.gguf') || fs.readFileSync(s.modelPath).subarray(0,4).toString()!=='GGUF')fail('INVALID_GGUF');
        // Fixture key reference only, never read secret contents.
        if(path.dirname(s.apiKeyFile)!==real || fs.lstatSync(s.apiKeyFile).isSymbolicLink() || !fs.statSync(s.apiKeyFile).isFile())fail('INVALID_KEY_REFERENCE');
        return freeze({version:1, profileId:id, settings:s, gpuIdentity:a.gpuIdentity,
            executableSha256:a.executableSha256,modelSha256:a.modelSha256});
    }
    const file=path.join(real,'revisions.sqlite');
    if(fs.existsSync(file)&&fs.lstatSync(file).isSymbolicLink())fail('REPARSE_REJECTED');
    const db=new DatabaseSync(file);
    db.exec(`PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA busy_timeout=0;
        CREATE TABLE IF NOT EXISTS activation_operations(operation_id TEXT PRIMARY KEY, revision INTEGER NOT NULL, digest TEXT NOT NULL, status TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS revisions(revision INTEGER PRIMARY KEY CHECK(revision>=0), profile TEXT NOT NULL, digest TEXT NOT NULL, parent TEXT NOT NULL, seal TEXT NOT NULL);
        CREATE TRIGGER IF NOT EXISTS revisions_no_update BEFORE UPDATE ON revisions BEGIN SELECT RAISE(ABORT,'immutable revision'); END;
        CREATE TRIGGER IF NOT EXISTS revisions_no_delete BEFORE DELETE ON revisions BEGIN SELECT RAISE(ABORT,'immutable revision'); END;`);
    const seal = r => crypto.createHmac('sha256',key).update(canonical(r)).digest('hex');
    function all() {
        const rows=db.prepare('SELECT * FROM revisions ORDER BY revision').all();let parent='';
        for(let i=0;i<rows.length;i++) {
            const r=rows[i]; const fields={revision:r.revision,profile:r.profile,digest:r.digest,parent:r.parent};
            if(r.revision!==i || r.parent!==parent || r.seal!==seal(fields) || hash(r.profile)!==r.digest)fail('STORE_TAMPERED');
            let p;try{p=JSON.parse(r.profile);}catch{fail('STORE_TAMPERED');}
            if(canonical(profile(p.profileId))!==r.profile)fail('APPROVAL_MISMATCH');
            parent=r.seal;
        }
        return rows;
    }
    function snapshot(r) {return r ? freeze({revision:r.revision,profileDigest:r.digest,profile:JSON.parse(r.profile)}) : null;}
    function transaction(fn) {
        db.exec('BEGIN IMMEDIATE');
        try {const value=fn();db.exec('COMMIT');return value;}catch(e){db.exec('ROLLBACK');throw e;}
    }
    return Object.freeze({
        append({expectedRevision,profileId,...extras}, beforeCommit=()=>{}) {
            if(Object.keys(extras).length || !(expectedRevision===null || Number.isSafeInteger(expectedRevision)&&expectedRevision>=0))fail('INVALID_REQUEST');
            return transaction(()=>{
                if(db.prepare("SELECT 1 FROM activation_operations WHERE status='incomplete'").get())fail('INCOMPLETE_ACTIVATION');
                const rows=all(),last=rows.at(-1);
                if((last?.revision??null)!==expectedRevision)fail('STALE_REVISION');
                const revision=last?last.revision+1:0;if(!Number.isSafeInteger(revision))fail('REVISION_OVERFLOW');
                const p=canonical(profile(profileId)),digest=hash(p);
                const fields={revision,profile:p,digest,parent:last?.seal||''};
                db.prepare('INSERT INTO revisions VALUES(?,?,?,?,?)').run(revision,p,digest,fields.parent,seal(fields));
                const hook = beforeCommit(); // Fault injection only; must be synchronous.
                if (hook && typeof hook.then === "function") fail("ASYNC_TRANSACTION_HOOK");
                return snapshot({...fields});
            });
        },
        history(){return all().map(snapshot);},
        beginActivation(request) {
            const bound=transaction(()=>{
                if(db.prepare("SELECT 1 FROM activation_operations WHERE status='incomplete'").get())fail('INCOMPLETE_ACTIVATION');
                if(db.prepare('SELECT 1 FROM activation_operations WHERE operation_id=?').get(request.operationId))fail('REPLAY');
                const target=this.bind(request);
                db.prepare("INSERT INTO activation_operations VALUES(?,?,?,'incomplete')").run(request.operationId,target.revision,target.profileDigest);
                return target;
            });
            // Marker commits before simulation. Interruption therefore blocks new work.
            db.exec('BEGIN IMMEDIATE');
            let finished=false;
            return Object.freeze({bound, finish(success) {
                if(finished)fail('ALREADY_FINISHED');finished=true;
                if(success) {
                    try {db.prepare("UPDATE activation_operations SET status='succeeded' WHERE operation_id=?").run(request.operationId);db.exec('COMMIT');}
                    catch(e){db.exec('ROLLBACK');throw e;}
                } else db.exec('ROLLBACK'); // Durable incomplete marker is deliberately retained.
            }});
        },
        incomplete(){return !!db.prepare("SELECT 1 FROM activation_operations WHERE status='incomplete'").get();},
        bind(request) {
            if(!request || typeof request.operationId!=='string' || !/^[a-zA-Z0-9-]{1,64}$/.test(request.operationId) ||
                !Number.isSafeInteger(request.expectedRevision)||request.expectedRevision<0)fail('INVALID_REQUEST');
            const rows=all(), r=rows[request.expectedRevision];
            if(!r)fail('UNKNOWN_REVISION');
            if(rows.at(-1).revision!==r.revision)fail('SUPERSEDED_REVISION');
            if(r.digest!==request.profileDigest)fail('PROFILE_DIGEST_MISMATCH');
            return freeze({operationId:request.operationId,...snapshot(r)});
        },
        revalidate(bound){return this.bind({operationId:bound.operationId,expectedRevision:bound.revision,profileDigest:bound.profileDigest});},
        close(){db.close();key.fill(0);}
    });
}
module.exports={openFixtureStore,canonical,hash};
