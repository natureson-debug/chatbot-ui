'use strict';

(function initializeNotifications(root, factory) {
    const api = factory();
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    } else {
        root.ChatbotNotifications = api.createNotificationCenter({
            document: root.document,
            setTimer: root.setTimeout.bind(root),
            clearTimer: root.clearTimeout.bind(root)
        });
    }
})(globalThis, function createNotificationsModule() {
    const DURATIONS = Object.freeze({
        success: 4000,
        information: 5000,
        warning: 10000,
        error: 0,
        critical: 0
    });
    const TITLES = Object.freeze({
        success: 'Success',
        information: 'Information',
        warning: 'Warning',
        error: 'Error',
        critical: 'Critical'
    });
    const ICONS = Object.freeze({
        success: '✓',
        information: 'i',
        warning: '!',
        error: '×',
        critical: '!'
    });
    const SAFE_DETAIL_KEYS = Object.freeze({
        eventCode: /^[A-Z][A-Z0-9_]{0,63}$/,
        category: /^(AUTH|PROVIDER|CONFIG|RUNTIME|SYSTEM)$/,
        correlationId: /^[A-Za-z0-9._:-]{1,128}$/,
        status: /^(?:[1-5]\d\d|failed|incomplete|interrupted)$/
    });

    function safeDetails(details) {
        if (!details || typeof details !== 'object' || Array.isArray(details)) return [];
        return Object.entries(SAFE_DETAIL_KEYS)
            .filter(([key, pattern]) => typeof details[key] === 'string' &&
                details[key].length <= 128 && pattern.test(details[key]))
            .map(([key]) => [key, details[key]]);
    }

    function createNotificationCenter({
        document,
        setTimer = setTimeout,
        clearTimer = clearTimeout,
        now = Date.now,
        windowObject = globalThis.window,
        maxVisible = 3
    }) {
        if (!document?.body || typeof document.createElement !== 'function') {
            throw new TypeError('A document body is required');
        }
        if (!Number.isSafeInteger(maxVisible) || maxVisible < 1 || maxVisible > 3) {
            throw new TypeError('maxVisible must be between 1 and 3');
        }

        const host = document.createElement('div');
        host.className = 'chatbot-notifications';
        host.setAttribute('role', 'region');
        host.setAttribute('aria-label', 'Notifications');
        document.body.appendChild(host);

        function positionHost() {
            const header = document.querySelector?.('body.admin-page .admin-header, body:not(.admin-page) .app > header');
            if (!header?.getBoundingClientRect) return;
            const top = Math.max(72, header.getBoundingClientRect().bottom + 12);
            host.style.setProperty('--notification-top', `${top}px`);
        }
        positionHost();
        windowObject?.addEventListener('resize', positionHost);

        const visible = new Map();
        const queued = [];
        let nextId = 0;

        function createElement(tag, className, text) {
            const element = document.createElement(tag);
            if (className) element.className = className;
            if (text !== undefined) element.textContent = text;
            return element;
        }

        function makeToast(item) {
            const toast = createElement('article', `notification-toast notification-toast--${item.severity}`);
            toast.setAttribute('role', item.severity === 'error' || item.severity === 'critical' ? 'alert' : 'status');
            toast.setAttribute('aria-atomic', 'true');

            const icon = createElement('span', 'notification-toast__icon', ICONS[item.severity]);
            icon.setAttribute('aria-hidden', 'true');

            const content = createElement('div', 'notification-toast__content');
            const title = createElement('strong', 'notification-toast__title', item.title);
            const message = createElement('p', 'notification-toast__message', item.message);
            content.append(title, message);

            if (item.details.length) {
                const detailsToggle = createElement('button', 'notification-toast__details-toggle', 'Details');
                detailsToggle.type = 'button';
                detailsToggle.setAttribute('aria-expanded', 'false');
                const details = createElement('dl', 'notification-toast__details');
                details.hidden = true;
                for (const [key, value] of item.details) {
                    details.append(
                        createElement('dt', '', key),
                        createElement('dd', '', value)
                    );
                }
                detailsToggle.addEventListener('click', () => {
                    details.hidden = !details.hidden;
                    detailsToggle.setAttribute('aria-expanded', String(!details.hidden));
                });
                content.append(detailsToggle, details);
            }

            const actions = createElement('div', 'notification-toast__actions');
            if (item.severity === 'critical') {
                const acknowledge = createElement('button', 'notification-toast__acknowledge', 'Acknowledge');
                acknowledge.type = 'button';
                acknowledge.addEventListener('click', () => dismiss(item.id));
                actions.appendChild(acknowledge);
            }
            const close = createElement('button', 'notification-toast__close', '×');
            close.type = 'button';
            close.setAttribute('aria-label', item.severity === 'critical'
                ? 'Acknowledge and dismiss critical notification'
                : 'Dismiss notification');
            close.addEventListener('click', () => dismiss(item.id));
            actions.appendChild(close);
            toast.append(icon, content, actions);

            toast.addEventListener('mouseenter', () => pause(item));
            toast.addEventListener('mouseleave', () => resume(item));
            toast.addEventListener('focusin', () => pause(item));
            toast.addEventListener('focusout', event => {
                if (!event.relatedTarget || !toast.contains?.(event.relatedTarget)) resume(item);
            });
            return toast;
        }

        function startTimer(item) {
            if (item.duration <= 0 || item.timer !== null) return;
            item.startedAt = now();
            item.timer = setTimer(() => dismiss(item.id), item.remaining);
        }

        function pause(item) {
            if (item.timer === null) return;
            clearTimer(item.timer);
            item.timer = null;
            item.remaining = Math.max(0, item.remaining - (now() - item.startedAt));
        }

        function resume(item) {
            if (item.duration > 0 && item.timer === null && visible.has(item.id)) startTimer(item);
        }

        function pump() {
            while (visible.size < maxVisible && queued.length) {
                const item = queued.shift();
                item.element = makeToast(item);
                visible.set(item.id, item);
                host.appendChild(item.element);
                startTimer(item);
            }
        }

        function dismiss(id) {
            const item = visible.get(id);
            if (item) {
                if (item.timer !== null) clearTimer(item.timer);
                item.timer = null;
                item.element.remove();
                visible.delete(id);
                pump();
                return true;
            }
            const index = queued.findIndex(candidate => candidate.id === id);
            if (index >= 0) {
                queued.splice(index, 1);
                return true;
            }
            return false;
        }

        function show(options = {}) {
            const severity = typeof options.severity === 'string' ? options.severity.toLowerCase() : '';
            if (!Object.hasOwn(DURATIONS, severity)) throw new TypeError('Unsupported notification severity');
            positionHost();
            const item = {
                id: ++nextId,
                severity,
                title: typeof options.title === 'string' && options.title.trim()
                    ? options.title.trim().slice(0, 100)
                    : TITLES[severity],
                message: typeof options.message === 'string' ? options.message.trim().slice(0, 500) : '',
                details: safeDetails(options.details),
                duration: DURATIONS[severity],
                remaining: DURATIONS[severity],
                timer: null,
                startedAt: 0,
                element: null
            };
            if (!item.message) item.message = TITLES[severity];
            queued.push(item);
            pump();
            return item.id;
        }

        function clear() {
            for (const item of visible.values()) {
                if (item.timer !== null) clearTimer(item.timer);
            }
            visible.clear();
            queued.length = 0;
            host.replaceChildren();
        }

        return Object.freeze({
            show,
            dismiss,
            clear,
            getState: () => Object.freeze({ visible: visible.size, queued: queued.length })
        });
    }

    return { createNotificationCenter };
});
