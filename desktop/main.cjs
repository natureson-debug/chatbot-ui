'use strict';
const { app, BrowserWindow, dialog } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { launchBackend } = require('./owned-backend.cjs');
let backend, window, quitting = false;
app.setName('AIChatbot');
// Fixed identity before lock acquisition: no second owned backend for this desktop installation.
app.setPath('userData', path.join(app.getPath('appData'), 'AIChatbot'));
if (!app.requestSingleInstanceLock()) app.quit();
else {
    app.on('second-instance', () => { window?.show(); window?.focus(); });
    app.on('window-all-closed', () => app.quit());
    app.on('before-quit', event => {
        if (quitting || !backend) return;
        event.preventDefault();
        backend.stop().then(() => { quitting = true; app.quit(); }, () => {
            dialog.showErrorBox('Shutdown incomplete', 'The owned backend has not confirmed exit. Keep this application open and review before retrying. No unrelated process was stopped.');
        });
    });
    app.whenReady().then(async () => {
        if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('APPLE_SILICON_MAC_REQUIRED');
        const root = app.getPath('userData');
        if (!fs.existsSync(path.join(root, 'data', 'chatbot.db'))) throw new Error('DATABASE_MISSING: Run the explicit desktop initialization command first. Existing installations must restore their database, not initialize again.');
        backend = launchBackend({ node: process.env.CHATBOT_DESKTOP_NODE || '/opt/homebrew/bin/node', root });
        const origin = await backend.ready;
        window = new BrowserWindow({ width: 1200, height: 820, minWidth: 390, show: false,
            webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true } });
        window.webContents.session.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
        window.webContents.session.setPermissionCheckHandler(() => false);
        window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
        const guard = (event, url) => { try { if (new URL(url).origin === origin) return; } catch {} event.preventDefault(); };
        window.webContents.on('will-navigate', guard);
        window.webContents.on('will-redirect', guard);
        backend.exit.then(() => { if (!quitting) app.quit(); });
        await window.loadURL(origin);
        window.show();
    }).catch(error => {
        dialog.showErrorBox('Desktop startup failed', String(error.message).startsWith('DATABASE_MISSING') ? error.message : 'Desktop backend could not start. Verify Apple Silicon, Node.js 24, and the initialized per-user database.');
        app.quit();
    });
}
