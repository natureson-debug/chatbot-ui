'use strict';
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { transform } = require('./protected-credentials');

const STATUS = Object.freeze({
    available: 'CREDENTIAL_AVAILABLE',
    missing: 'CREDENTIAL_MISSING',
    inaccessible: 'CREDENTIAL_INACCESSIBLE',
    undecryptable: 'CREDENTIAL_UNDECRYPTABLE',
    unsupported: 'CREDENTIAL_UNSUPPORTED_PLATFORM',
    removed: 'CREDENTIAL_REMOVED',
    failure: 'CREDENTIAL_BACKEND_FAILURE'
});

function fileFor(descriptor, root) {
    if (!descriptor || descriptor.source !== 'protected' || typeof descriptor.reference !== 'string') return null;
    if (descriptor.reference === 'protected:brave-search') return path.join(root, 'brave-search.dpapi');
    const match = /^protected:([a-z][a-z0-9-]{0,47})$/.exec(descriptor.reference);
    if (!match) return null;
    return path.join(root, match[1] + '.dpapi');
}

function decodeSecret(buffer) {
    if (!Buffer.isBuffer(buffer) || buffer.length === 0 || buffer.length > 4096) throw Error('INVALID_SECRET');
    const value = buffer.toString('utf8');
    if (!value || /[\r\n\x00]/.test(value)) throw Error('INVALID_SECRET');
    return value;
}

function createDpapiBackend({
    root,
    fs = require('node:fs/promises'),
    crypt = transform,
    platform = process.platform
} = {}) {
    if (typeof root !== 'string' || !root) throw new TypeError('A protected credential root is required');

    async function withFs(file, action) {
        try {
            return await action(file);
        } catch (error) {
            if (error?.code === 'ENOENT') return { status: 'missing' };
            if (error?.code === 'EACCES' || error?.code === 'EPERM') return { status: 'inaccessible' };
            return { status: 'failure' };
        }
    }

    async function status(descriptor) {
        if (platform !== 'win32') return { status: 'unsupported' };
        const file = fileFor(descriptor, root);
        if (!file) return { status: 'failure' };
        const found = await withFs(file, async f => {
            const stat = await fs.stat(f);
            if (!stat.isFile()) return { status: 'failure' };
            const blob = await fs.readFile(f);
            if (blob.length > 32768) return { status: 'failure' };
            return { status: 'available', blob };
        });
        if (found.status !== 'available' || !found.blob) return found;
        try {
            const plain = await crypt('unprotect', found.blob, descriptor.binding);
            decodeSecret(plain);
            return { status: 'available' };
        } catch {
            // Existing DPAPI cannot reliably distinguish locked/inaccessible from bad entropy.
            return { status: 'undecryptable' };
        }
    }

    async function resolve(descriptor) {
        if (platform !== 'win32') return { status: 'unsupported' };
        const file = fileFor(descriptor, root);
        if (!file) return { status: 'failure' };
        const found = await withFs(file, async f => {
            const blob = await fs.readFile(f);
            if (blob.length > 32768) return { status: 'failure' };
            return { status: 'available', blob };
        });
        if (found.status !== 'available' || !found.blob) return found;
        try {
            const plain = await crypt('unprotect', found.blob, descriptor.binding);
            return { status: 'available', secret: decodeSecret(plain) };
        } catch {
            return { status: 'undecryptable' };
        }
    }

    async function replace(descriptor, secret, { authorize } = {}) {
        if (platform !== 'win32') return { status: 'unsupported' };
        const file = fileFor(descriptor, root);
        if (!file) return { status: 'failure' };
        if (typeof secret !== 'string' || !secret.trim() || secret.length > 4096 || /[\r\n\x00]/.test(secret)) return { status: 'failure' };
        try {
            const blob = await crypt('protect', Buffer.from(secret.trim()), descriptor.binding);
            await fs.mkdir(root, { recursive: true });
            const temp = file + '.' + randomUUID() + '.tmp';
            try {
                await fs.writeFile(temp, blob, { flag: 'wx', mode: 0o600 });
                if (!await authorize()) return { status: 'denied' };
                await fs.rename(temp, file);
                return { status: 'available' };
            } finally {
                await fs.unlink(temp).catch(() => {});
            }
        } catch {
            return { status: 'failure' };
        }
    }

    async function remove(descriptor, _secret, { authorize } = {}) {
        if (platform !== 'win32') return { status: 'unsupported' };
        const file = fileFor(descriptor, root);
        if (!file) return { status: 'failure' };
        try {
            if (!await authorize()) return { status: 'denied' };
            await fs.unlink(file);
            return { status: 'removed' };
        } catch (error) {
            if (error?.code === 'ENOENT') return { status: 'removed' };
            if (error?.code === 'EACCES' || error?.code === 'EPERM') return { status: 'inaccessible' };
            return { status: 'failure' };
        }
    }

    return Object.freeze({ status, resolve, replace, remove });
}

module.exports = { createDpapiBackend, fileFor, STATUS };
