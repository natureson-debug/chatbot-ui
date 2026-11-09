'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
function initialize(root, username, password) {
    if (!path.isAbsolute(root) || typeof username !== 'string' || !/^[a-zA-Z0-9_-]{3,64}$/.test(username) || typeof password !== 'string' || password.length < 12) throw new Error('INVALID_INITIALIZATION_INPUT');
    const file = path.join(root, 'data', 'chatbot.db');
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    require('../core/database-startup').initializeDatabase(file);
    const db = require('../core/database-startup').openExistingDatabase(file);
    try { db.prepare('INSERT INTO users(id, username, password_hash, is_admin) VALUES (?, ?, ?, 1)').run(randomUUID(), username, require('../auth').hashPassword(password)); }
    finally { db.close(); }
}
if (require.main === module) {
    if (process.platform !== 'darwin' || process.argv[2] !== '--create-new-installation') {
        console.error('Explicit macOS first-run initialization required.'); process.exitCode = 1;
    } else {
        const { Writable } = require('node:stream');
        let hidden = false;
        const output = new Writable({ write(chunk, _encoding, callback) { if (!hidden) process.stdout.write(chunk); callback(); } });
        const rl = require('node:readline/promises').createInterface({ input: process.stdin, output, terminal: true });
        (async () => {
            if (!process.stdin.isTTY) throw new Error();
            const username = await rl.question('New administrator username: ');
            process.stdout.write('Password (12+ characters, hidden): '); hidden = true;
            const password = await rl.question('');
            hidden = false; process.stdout.write('\n');
            initialize(path.join(require('node:os').homedir(), 'Library', 'Application Support', 'Renitech', 'Chatbot'), username, password);
            console.log('Initialized new desktop database.');
        })().catch(() => { console.error('Initialization failed; existing files are never replaced. Review the data directory before retrying.'); process.exitCode = 1; }).finally(() => rl.close());
    }
}
module.exports = { initialize };
