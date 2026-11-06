'use strict';
// Standalone administrator diagnostic. Never imported by startup or storage code.
const path = require('node:path');
const { execFile } = require('node:child_process');
const SCRIPT = path.join(__dirname, 'attachment-security-inspect.ps1');
const RIGHTS = ['write', 'delete', 'deleteChild', 'writeDac', 'writeOwner', 'replace'];

function ancestors(input) {
    if (typeof input !== 'string' || !/^[A-Za-z]:\\/.test(input) || /[\x00-\x1f<>"|?*]/.test(input) || input.slice(2).includes(':') || input.split('\\').some(x => x === '..' || /[ .]$/.test(x))) throw Error('Invalid storage path');
    const root = path.win32.normalize(input);
    const result = [root];
    while (path.win32.dirname(result[0]) !== result[0]) result.unshift(path.win32.dirname(result[0]));
    return result;
}

function collectWindows(paths) {
    return new Promise((resolve, reject) => {
        if (process.platform !== 'win32' || !process.env.SystemRoot) return reject(Error('Windows inspection unavailable'));
        const executable = path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
        const child = execFile(executable, ['-NoProfile', '-NonInteractive', '-File', SCRIPT],
            { windowsHide: true, timeout: 15000, maxBuffer: 1024 * 1024 }, (error, stdout) => {
                if (error) return reject(Error('Windows inspection unavailable'));
                try { resolve(JSON.parse(stdout)); } catch { reject(Error('Invalid inspection response')); }
            });
        child.stdin.on('error', () => {});
        child.stdin.end(JSON.stringify(paths));
    });
}

async function inspectAttachmentStorage(input, { collect = collectWindows, assessEffectiveAccess } = {}) {
    let paths;
    const result = { status: 'SECURITY_UNVERIFIED', reasons: [], firstMissing: null, evidence: [] };
    try { paths = ancestors(input); } catch { result.reasons.push('INVALID_PATH'); return result; }
    let observations;
    try { observations = await collect(paths); } catch { result.reasons.push('INSPECTION_FAILED'); return result; }
    if (!Array.isArray(observations) || observations.length !== paths.length) { result.reasons.push('INCOMPLETE_INSPECTION'); return result; }
    let unsafe = false, complete = true;
    for (let i = 0; i < paths.length; i++) {
        const item = observations[i];
        if (!item || item.path !== paths[i]) { complete = false; result.reasons.push('PATH_EVIDENCE_MISMATCH'); continue; }
        result.evidence.push(item);
        if (item.state === 'missing') { result.firstMissing ||= item.path; complete = false; continue; }
        if (item.state !== 'existing' || result.firstMissing) { complete = false; result.reasons.push('ANCESTOR_UNVERIFIED'); continue; }
        if (item.reparse === true || item.directory === false) { unsafe = true; result.reasons.push('REPARSE_OR_NON_DIRECTORY'); continue; }
        if (item.reparse !== false || item.directory !== true || !item.sddl || !item.ownerSid || item.principalsResolved !== true) {
            complete = false; result.reasons.push('ACL_OR_PRINCIPAL_UNVERIFIED'); continue;
        }
        // A DACL is not effective access. This optional trusted adapter must cover
        // group membership, deny ACEs, ownership and parent replacement authority.
        let proof;
        try { proof = assessEffectiveAccess && await assessEffectiveAccess(item, observations[i - 1] || null); } catch { /* fail closed */ }
        if (!proof || proof.path !== item.path || proof.sddl !== item.sddl || proof.complete !== true ||
            proof.identitiesComplete !== true || proof.groupsComplete !== true || proof.ownerTrusted !== true ||
            !proof.unrelated || !RIGHTS.every(right => typeof proof.unrelated[ right ] === 'boolean')) {
            complete = false; result.reasons.push('EFFECTIVE_ACCESS_UNVERIFIED'); continue;
        }
        if (RIGHTS.some(right => proof.unrelated[right])) { unsafe = true; result.reasons.push('UNRELATED_EFFECTIVE_MUTATION'); }
    }
    if (result.firstMissing) result.reasons.push('ROOT_NOT_PROVISIONED_INHERITANCE_UNVERIFIED');
    result.status = unsafe ? 'STORAGE_ROOT_UNSAFE' : complete ? 'STORAGE_ROOT_QUALIFIED' : 'SECURITY_UNVERIFIED';
    result.reasons = [...new Set(result.reasons)];
    return result;
}
module.exports = { inspectAttachmentStorage, ancestors };
