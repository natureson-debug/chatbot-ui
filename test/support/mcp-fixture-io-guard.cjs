'use strict';
// Preload SDK dependencies before instrumenting runtime I/O (module loading reads files).
require('@modelcontextprotocol/sdk/server/index.js');
require('@modelcontextprotocol/sdk/server/stdio.js');
require('@modelcontextprotocol/sdk/types.js');
require('node:crypto');
const fs=require('node:fs');
const deny=()=>{process.stderr.write('FORBIDDEN_FIXTURE_IO\n');throw Error('Forbidden fixture runtime I/O');};
for(const name of ['readFile','readFileSync','writeFile','writeFileSync','appendFile','appendFileSync','open','openSync','unlink','unlinkSync','mkdir','mkdirSync','readdir','readdirSync']){
 // Allow CommonJS to load the fixture itself, but not fixture-originated reads.
 const original=fs[name];fs[name]=function(...args){if((name==='readFileSync'||name==='openSync')&&String(args[0]).endsWith('mcp-readonly-fixture.cjs'))return original.apply(this,args);return deny();};
}
for(const name of ['readFile','writeFile','appendFile','open','unlink','mkdir','readdir'])fs.promises[name]=deny;
for(const [mod,names] of [['node:net',['connect','createConnection','createServer']],['node:http',['request','get','createServer']],['node:https',['request','get','createServer']],['node:child_process',['spawn','exec','execFile','fork']],['node:dgram',['createSocket']]]){const api=require(mod);for(const name of names)api[name]=deny;}
global.fetch=deny;
