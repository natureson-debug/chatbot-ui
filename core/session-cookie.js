'use strict';
// Process-local opt-in by the desktop entry point only. Never consult environment
// variables, Host, or proxy headers when deciding whether to omit Secure.
let desktopHost = null;
let sealed = false;
function enableDesktopLoopback(host) {
    if (sealed || host !== '127.0.0.1') throw new Error('DESKTOP_COOKIE_MODE_REJECTED');
    desktopHost = host;
}
function createSessionCookiePolicy(host) {
    if (desktopHost !== null && host !== desktopHost) throw new Error('DESKTOP_COOKIE_BINDING_REJECTED');
    sealed = true;
    const desktop = desktopHost !== null;
    return (token, localAddress) => {
        if (desktop && localAddress !== '127.0.0.1') throw new Error('DESKTOP_COOKIE_BINDING_REJECTED');
        return `chatbot_session=${token}; HttpOnly; ${desktop ? '' : 'Secure; '}SameSite=Strict; Path=/; Max-Age=${token ? 86400 : 0}`;
    };
}
module.exports = { enableDesktopLoopback, createSessionCookiePolicy };
