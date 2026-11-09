'use strict';
const { fork } = require('node:child_process');
const path = require('node:path');
const { desktopEnvironment } = require('./environment.cjs');
function launchBackend({ node, root, env = process.env, timeout = 30000 }) {
    if (!path.isAbsolute(node)) throw new Error('ABSOLUTE_NODE_EXECUTABLE_REQUIRED');
    const child = fork(path.join(__dirname, 'backend.cjs'), [], {
        execPath: node, execArgv: [], cwd: path.join(__dirname, '..'),
        env: { ...desktopEnvironment(root, env), CHATBOT_DESKTOP_CHILD: '1' },
        detached: false, windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc']
    });
    let exited = false;
    const exit = new Promise(resolve => child.once('exit', () => { exited = true; resolve(); }));
    let stopPromise;
    function stop() {
        if (!stopPromise) stopPromise = (async () => {
            if (exited) return;
            if (child.connected) child.send({ type: 'stop' }, () => {});
            let timer;
            try { await Promise.race([exit, new Promise((_, reject) => {
                timer = setTimeout(() => reject(new Error('BACKEND_SHUTDOWN_UNVERIFIED')), 25000);
            })]); } finally { clearTimeout(timer); }
        })();
        return stopPromise;
    }
    const ready = new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('BACKEND_STARTUP_TIMEOUT')), timeout);
        const done = (error, value) => { clearTimeout(timer); error ? reject(error) : resolve(value); };
        child.once('error', () => done(new Error('BACKEND_LAUNCH_FAILED')));
        child.once('exit', () => done(new Error('BACKEND_EXITED')));
        child.on('message', async message => {
            if (message?.type !== 'ready' || !Number.isInteger(message.port) || message.port < 1 || message.port > 65535) return;
            const origin = `http://127.0.0.1:${message.port}`;
            try {
                const health = await fetch(`${origin}/health`, { signal: AbortSignal.timeout(5000) });
                if (!health.ok) throw new Error();
                done(null, origin);
            } catch { done(new Error('BACKEND_NOT_READY')); }
        });
    });
    return { child, ready, stop, exit };
}
module.exports = { launchBackend };
