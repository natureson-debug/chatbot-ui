'use strict';
// No lifecycle authority: validate browser intent before the existing ownership gate.
function validRestartRequest(req) {
    const headers = req.headers || {};
    if (headers['x-chatbot-action'] !== 'restart-ai' ||
        (headers['sec-fetch-site'] && headers['sec-fetch-site'] !== 'same-origin')) return false;
    const host = headers.host || '';
    if (headers['sec-fetch-site'] === 'same-origin' && !headers.origin &&
        /^(127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/i.test(host)) return true;
    try {
        const origin = new URL(headers.origin);
        return origin.origin === headers.origin && origin.host === headers.host &&
            (origin.protocol === 'https:' ||
                (origin.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(origin.hostname)));
    } catch { return false; }
}
module.exports = { validRestartRequest };
