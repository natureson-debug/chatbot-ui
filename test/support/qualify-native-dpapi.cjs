'use strict';
// Manual only. No test-runner registration or production credential-store calls.
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const report = (state, category) => console.log(`${state} ${category}`);
const inside = (parent, child) => {
    const relative = path.relative(parent, child);
    return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
};
const matches = (actual, expected) => {
    if (typeof actual !== 'string') return false;
    const bytes = Buffer.from(actual);
    return bytes.length === expected.length && crypto.timingSafeEqual(bytes, expected);
};

async function main() {
    if (process.argv.length !== 3 || process.argv[2] !== '--manual-native-test') {
        report('SKIP', 'MANUAL_OPT_IN_REQUIRED'); process.exitCode = 2; return;
    }
    if (process.platform !== 'win32') { report('SKIP', 'WINDOWS_REQUIRED'); return; }
    let root, base, failed = false;
    try {
        base = await fs.realpath(os.tmpdir());
        const repository = await fs.realpath(path.resolve(__dirname, '../..'));
        // Reject production/project storage even if TEMP has been overridden.
        if (inside(repository, base) || inside('C:\\AI', base)) throw Error();
        root = await fs.mkdtemp(path.join(base, 'chatbot-native-dpapi-'));
        const realRoot = await fs.realpath(root);
        if (path.dirname(realRoot).toLowerCase() !== base.toLowerCase()) throw Error();
        const legacy = require('../../core/protected-credentials');
        const { createDpapiBackend } = require('../../core/dpapi-backend');
        const { createCredentialService } = require('../../core/credential-service');
        const contexts = [
            { label: 'DEEPSEEK', id: 'native-fixture', adapter: 'deepseek-chat', endpoint: 'https://fixture.invalid', credentialRef: 'protected:native-fixture' },
            { label: 'BRAVE', provider: 'brave-search', credentialRef: 'protected:brave-search' }
        ];
        for (const context of contexts) {
            const storage = path.join(root, context.label.toLowerCase());
            await fs.mkdir(storage);
            const backend = createDpapiBackend({ root: storage });
            const service = createCredentialService({ backends: { protected: backend }, authorize: () => true });
            const entropy = legacy.binding(context);
            const descriptor = { source: 'protected', reference: context.credentialRef, binding: entropy };
            const file = path.join(storage, context.label === 'BRAVE' ? 'brave-search.dpapi' : context.id + '.dpapi');
            let first = crypto.randomBytes(32).toString('hex');
            let second = crypto.randomBytes(32).toString('hex');
            try {
                const blob = await legacy.transform('protect', Buffer.from(first), entropy);
                await fs.writeFile(file, blob, { flag: 'wx', mode: 0o600 });
                const decoded = await service.resolve(context.credentialRef, context);
                if (decoded.status !== 'available' || !matches(decoded.secret, Buffer.from(first))) throw Error();
                report('PASS', context.label + '_LEGACY_TO_ADAPTER');

                const saved = await service.replace(context.credentialRef, second, context);
                if (saved.status !== 'available' || Object.hasOwn(saved, 'secret')) throw Error();
                const stored = await fs.readFile(file);
                const plain = await legacy.transform('unprotect', stored, entropy);
                if (!matches(plain.toString('utf8'), Buffer.from(second))) throw Error();
                plain.fill(0);
                report('PASS', context.label + '_ADAPTER_TO_LEGACY');

                // Exercise native entropy rejection, not just reference validation.
                const wrongBinding = entropy + '-incorrect-fixture-binding';
                let rejected = false;
                try { await legacy.transform('unprotect', stored, wrongBinding); } catch { rejected = true; }
                const wrong = await backend.resolve({ ...descriptor, binding: wrongBinding });
                if (!rejected || wrong.status === 'available' || Object.hasOwn(wrong, 'secret')) throw Error();
                // Positive control after the negative probe rules out a broken transform.
                const control = await service.resolve(context.credentialRef, context);
                if (control.status !== 'available' || !matches(control.secret, Buffer.from(second))) throw Error();
                report('PASS', context.label + '_WRONG_BINDING_REJECTED');
            } catch {
                failed = true; report('FAIL', context.label + '_COMPATIBILITY_OR_DPAPI_UNAVAILABLE');
            } finally { first = null; second = null; }
        }
    } catch { failed = true; report('FAIL', 'SETUP_OR_NATIVE_DEPENDENCY'); }
    finally {
        if (root) {
            try {
                const stat = await fs.lstat(root);
                if (stat.isSymbolicLink() || !stat.isDirectory() || path.dirname(root).toLowerCase() !== base.toLowerCase() || !path.basename(root).startsWith('chatbot-native-dpapi-')) throw Error();
                await fs.rm(root, { recursive: true, force: false });
                try { await fs.lstat(root); throw Error('still present'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
                report('PASS', 'DISPOSABLE_CLEANUP');
            } catch { failed = true; report('FAIL', 'DISPOSABLE_CLEANUP'); }
        }
    }
    report(failed ? 'FAIL' : 'PASS', 'NATIVE_DPAPI_QUALIFICATION');
    process.exitCode = failed ? 1 : 0;
}
main().catch(() => { report('FAIL', 'RUNNER_FAILURE'); process.exitCode = 1; });
