'use strict';
// Only launched over a private parent/child IPC channel, never as a service.
if (!process.send || !process.env.CHATBOT_DESKTOP_CHILD) throw new Error('DESKTOP_PARENT_REQUIRED');
if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('NODE_24_REQUIRED');
const config = require('../core/config');
config.PORT = 0; // OS chooses the port atomically; no probe/release/rebind race.
const { server } = require('../server');
let stopping = false;
async function stop() {
    if (stopping) return;
    stopping = true;
    if (!server.listening) await require('node:events').once(server, 'listening');
    const result = await require('../core/application-lifecycle').installApplicationLifecycle({ server }).shutdown();
    if (process.connected) process.send({ type: 'stopped', completed: result.completed });
    if (process.connected) process.disconnect();
}
process.on('message', message => { if (message?.type === 'stop') void stop(); });
process.on('disconnect', () => void stop());
server.once('listening', () => {
    if (!process.connected) void stop();
    else process.send({ type: 'ready', port: server.address().port });
});
