'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { initializeSchema } = require('../core/database-schema');
const { validateDatabase } = require('../scripts/check-managed-node-db.cjs');
test('valid disposable schema passes repeatedly without changing contents', () => {
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'node-start-check-'));
 try { const file=path.join(dir,'test.db'); const db=new DatabaseSync(file); initializeSchema(db); db.close();
 const before=fs.readFileSync(file); validateDatabase(file); validateDatabase(file); assert.deepEqual(fs.readFileSync(file),before);
 } finally { fs.rmSync(dir,{recursive:true,force:true}); }
});
test('missing, empty, corrupt, unrelated and relative databases are rejected', () => {
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'node-start-reject-'));
 try { const file=path.join(dir,'test.db'); assert.throws(()=>validateDatabase(file)); assert.equal(fs.existsSync(file),false);
 for(const data of ['', 'not sqlite']) { fs.writeFileSync(file,data); assert.throws(()=>validateDatabase(file)); assert.equal(fs.readFileSync(file,'utf8'),data); }
 fs.unlinkSync(file); const db=new DatabaseSync(file); db.exec('CREATE TABLE unrelated(id)'); db.close(); assert.throws(()=>validateDatabase(file));
 assert.throws(()=>validateDatabase('relative.db')); assert.throws(()=>validateDatabase(undefined));
 } finally { fs.rmSync(dir,{recursive:true,force:true}); }
});
