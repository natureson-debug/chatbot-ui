'use strict';

function createAdminLogs({ document, fetch, setTimer = setTimeout, clearTimer = clearTimeout, clipboard = globalThis.navigator?.clipboard, windowObject = globalThis.window }) {
    const panel = document.getElementById('tab-logs');
    const status = document.getElementById('systemLogsStatus');
    const rows = document.getElementById('systemLogsRows');
    const count = document.getElementById('systemLogsCount');
    const lastRefresh = document.getElementById('systemLogsLastRefresh');
    const pageLabel = document.getElementById('systemLogsPage');
    const pageSize = document.getElementById('systemLogsPageSize');
    const autoRefresh = document.getElementById('systemLogsAutoRefresh');
    const refreshButton = document.getElementById('systemLogsRefresh');
    const previousButton = document.getElementById('systemLogsPrevious');
    const nextButton = document.getElementById('systemLogsNext');
    const filterForm = document.getElementById('systemLogsFilters');
    const notifications = document.getElementById('systemLogsNotifications');
    const detailDialog = document.getElementById('systemLogDetailDialog');
    let page = 1;
    let total = 0;
    let inFlight = false;
    let stopped = false;
    let unauthorized = false;
    let initialized = false;
    let timer = null;
    let controller = null;
    let epoch = 0;
    let focusedBeforeDialog = null;
    const seenEventIds = new Set();
    const controls = {
        severity: document.getElementById('systemLogsSeverity'),
        category: document.getElementById('systemLogsCategory'),
        eventCode: document.getElementById('systemLogsEventCode'),
        providerId: document.getElementById('systemLogsProviderId'),
        from: document.getElementById('systemLogsFrom'),
        to: document.getElementById('systemLogsTo'),
        correlationId: document.getElementById('systemLogsCorrelationId')
    };

    function element(tag, text, className) {
        const node = document.createElement(tag);
        if (text !== undefined) node.textContent = text;
        if (className) node.className = className;
        return node;
    }

    function active() {
        return !stopped && !document.hidden && !panel.hidden;
    }

    function intervalMs() {
        const seconds = Number(autoRefresh.value);
        return [15, 30, 60].includes(seconds) ? seconds * 1000 : 0;
    }

    function currentFilters() {
        const filters = {};
        for (const [key, input] of Object.entries(controls)) {
            if (!input.value) continue;
            if (key === 'from') filters.from = `${input.value}T00:00:00.000Z`;
            else if (key === 'to') filters.to = `${input.value}T23:59:59.999Z`;
            else filters[key] = input.value.trim();
        }
        return filters;
    }

    function requestUrl(requestPage = page, requestPageSize = Number(pageSize.value)) {
        const params = new URLSearchParams();
        for (const [key, value] of Object.entries(currentFilters())) params.set(key, value);
        params.set('page', String(requestPage));
        params.set('pageSize', String(requestPageSize));
        return `/api/admin/system-logs?${params}`;
    }

    function eventTime(timestamp) {
        const date = new Date(timestamp);
        return Number.isNaN(date.getTime()) ? 'Unknown time' : date.toLocaleString();
    }

    function eventButton(event) {
        const button = element('button', event.eventCode || 'Unknown event', 'system-log-event-link');
        button.type = 'button';
        button.setAttribute('aria-label', `View details for ${event.eventCode || 'system event'}`);
        button.addEventListener('click', () => showDetails(event));
        return button;
    }

    function render(events) {
        rows.replaceChildren();
        if (!events.length) {
            const row = element('tr');
            const cell = element('td', 'No events match these filters.');
            cell.colSpan = 7;
            cell.className = 'system-logs-empty';
            row.append(cell);
            rows.append(row);
            return;
        }
        for (const event of events) {
            const row = element('tr');
            const timestamp = element('td', eventTime(event.timestamp));
            timestamp.title = event.timestamp || '';
            row.append(timestamp);
            const severity = element('td');
            severity.append(element('span', event.severity || 'UNKNOWN',
                `system-log-severity severity-${String(event.severity || 'unknown').toLowerCase()}`));
            row.append(severity);
            row.append(element('td', event.category || '—'));
            const code = element('td');
            code.append(eventButton(event));
            row.append(code);
            row.append(element('td', event.message || '—'));
            row.append(element('td', event.providerId || '—'));
            row.append(element('td', event.outcome || '—'));
            rows.append(row);
        }
    }

    function updateSummary(events) {
        const first = total === 1 ? 'event' : 'events';
        count.textContent = `${total.toLocaleString()} matching ${first}`;
        pageLabel.textContent = `Page ${page}`;
        previousButton.disabled = page <= 1;
        nextButton.disabled = page * Number(pageSize.value) >= total;
        lastRefresh.textContent = `Last refreshed ${new Date().toLocaleTimeString()}`;
        render(events);
    }

    function remember(events) {
        for (const event of events) {
            if (event.eventId) seenEventIds.add(event.eventId);
        }
        if (seenEventIds.size > 2000) {
            const retained = [...seenEventIds].slice(-1000);
            seenEventIds.clear();
            retained.forEach(id => seenEventIds.add(id));
        }
    }

    function isSignificant(event) {
        if (event.severity === 'ERROR') return true;
        return event.severity === 'WARN' && [
            'AUTH_ADMIN_ACCESS_DENIED',
            'AUTH_LOGIN_FAILED',
            'PROVIDER_CONNECTION_TEST_FAILED',
            'RUNTIME_BACKEND_HEALTH_CHANGED'
        ].includes(event.eventCode);
    }

    function notify(event) {
        const item = element('article', undefined, `system-log-notification severity-${String(event.severity).toLowerCase()}`);
        const content = element('div');
        content.append(element('strong', `${event.severity}: ${event.eventCode}`));
        content.append(element('p', event.message || 'A significant system event occurred.'));
        const dismiss = element('button', 'Dismiss');
        dismiss.type = 'button';
        dismiss.setAttribute('aria-label', `Dismiss notification for ${event.eventCode}`);
        dismiss.addEventListener('click', () => item.remove());
        item.append(content, dismiss);
        notifications.prepend(item);
        while (notifications.children.length > 5) notifications.lastElementChild.remove();
    }

    function showDetails(event) {
        const detailTitle = document.getElementById('systemLogDetailTitle');
        const detailFields = document.getElementById('systemLogDetailFields');
        const copyStatus = document.getElementById('systemLogCopyStatus');
        const copyButton = document.getElementById('systemLogCopy');
        const safeEvent = {
            eventId: event.eventId,
            timestamp: event.timestamp,
            severity: event.severity,
            category: event.category,
            eventCode: event.eventCode,
            message: event.message,
            metadata: event.metadata,
            correlationId: event.correlationId,
            actorId: event.actorId,
            providerId: event.providerId,
            outcome: event.outcome
        };
        const copyEvent = Object.fromEntries(
            Object.entries(safeEvent).filter(([, value]) => value !== null && value !== undefined && value !== '')
        );
        detailTitle.textContent = event.eventCode || 'System event details';
        detailFields.replaceChildren();
        for (const [key, value] of Object.entries(safeEvent)) {
            const group = element('div', undefined, 'system-log-detail-field');
            group.append(element('dt', key === 'timestamp' ? 'Timestamp (UTC)' : key));
            const description = element('dd');
            description.textContent = value === null || value === undefined || value === ''
                ? 'Unavailable'
                : typeof value === 'object'
                ? JSON.stringify(value, null, 2)
                : String(value);
            if (key === 'metadata') description.className = 'system-log-metadata';
            group.append(description);
            detailFields.append(group);
        }
        copyStatus.textContent = '';
        focusedBeforeDialog = document.activeElement;
        copyButton.onclick = async () => {
            try {
                if (!clipboard?.writeText) throw new Error('Clipboard unavailable');
                await clipboard.writeText(JSON.stringify(copyEvent, null, 2));
                copyStatus.textContent = 'Event details copied.';
            } catch {
                copyStatus.textContent = 'Could not copy event details.';
            }
        };
        detailDialog.showModal();
        document.getElementById('systemLogClose').focus();
    }

    function clearUnauthorized(httpStatus) {
        unauthorized = true;
        clearTimer(timer);
        timer = null;
        rows.replaceChildren();
        notifications.replaceChildren();
        total = 0;
        count.textContent = '0 matching events';
        status.textContent = httpStatus === 401
            ? 'Your administrator session has expired. Sign in again to view system logs.'
            : 'Administrator access is required to view system logs.';
    }

    async function getResult(url, signal) {
        const response = await fetch(url, {
            credentials: 'same-origin',
            cache: 'no-store',
            signal
        });
        if (response.status === 401 || response.status === 403) {
            clearUnauthorized(response.status);
            return null;
        }
        if (!response.ok) {
            const error = new Error('unavailable');
            if (response.status === 400) error.kind = 'invalid-filter';
            throw error;
        }
        const result = await response.json();
        if (!result || !Array.isArray(result.events) || !Number.isSafeInteger(result.total)) {
            throw new Error('invalid response');
        }
        return result;
    }

    function schedulePoll() {
        clearTimer(timer);
        timer = null;
        if (controls.from.value && controls.to.value && controls.from.value > controls.to.value) return;
        if (!active() || unauthorized || !initialized || !intervalMs()) return;
        timer = setTimer(() => {
            timer = null;
            void refresh({ monitor: true });
        }, intervalMs());
    }

    async function refresh({ monitor = false, seed = false } = {}) {
        if (!active() || unauthorized) return;
        if (inFlight) {
            schedulePoll();
            return;
        }
        inFlight = true;
        const requestEpoch = epoch;
        controller = new AbortController();
        if (!monitor) status.textContent = 'Loading system events...';
        refreshButton.disabled = true;
        try {
            const startDate = controls.from.value;
            const endDate = controls.to.value;
            if (startDate && endDate && startDate > endDate) {
                status.textContent = 'The start date must be on or before the end date.';
                return;
            }
            const result = await getResult(requestUrl(), controller.signal);
            if (requestEpoch !== epoch || !active() || !result) return;
            total = result.total;
            updateSummary(result.events);
            status.textContent = total ? 'System events loaded.' : 'No system events match the current filters.';
            if (seed || !initialized) {
                remember(result.events);
                if (page !== 1) {
                    const newest = await getResult(requestUrl(1, 100), controller.signal);
                    if (requestEpoch !== epoch || !active() || !newest) return;
                    remember(newest.events);
                }
            } else if (monitor) {
                let currentEvents = result.events;
                if (page !== 1) {
                    const newest = await getResult(requestUrl(1, 25), controller.signal);
                    if (requestEpoch !== epoch || !active() || !newest) return;
                    currentEvents = newest.events;
                }
                for (const event of currentEvents) {
                    if (event.eventId && !seenEventIds.has(event.eventId) && isSignificant(event)) notify(event);
                }
                remember(currentEvents);
            }
            initialized = true;
            lastRefresh.textContent = `Last refreshed ${new Date().toLocaleTimeString()}`;
        } catch (error) {
            if (requestEpoch === epoch && active()) {
                status.textContent = error.kind === 'invalid-filter'
                    ? 'One or more filters are invalid. Review the values and try again.'
                    : 'System logs are temporarily unavailable. Try refreshing.';
            }
        } finally {
            if (requestEpoch === epoch) {
                controller = null;
                inFlight = false;
                refreshButton.disabled = false;
                schedulePoll();
            }
        }
    }

    function enter() {
        if (!active() || unauthorized) return;
        if (!initialized) void refresh({ seed: true });
        else schedulePoll();
    }

    function suspend() {
        epoch++;
        clearTimer(timer);
        timer = null;
        controller?.abort();
        controller = null;
        inFlight = false;
    }

    filterForm.addEventListener('submit', event => {
        event.preventDefault();
        page = 1;
        void refresh({ seed: true });
    });
    document.getElementById('systemLogsClear').addEventListener('click', () => {
        Object.values(controls).forEach(input => { input.value = ''; });
        page = 1;
        void refresh({ seed: true });
    });
    refreshButton.addEventListener('click', () => void refresh({ seed: true }));
    autoRefresh.addEventListener('change', schedulePoll);
    pageSize.addEventListener('change', () => {
        page = 1;
        void refresh({ seed: true });
    });
    previousButton.addEventListener('click', () => {
        if (page > 1) {
            page--;
            void refresh({ seed: true });
        }
    });
    nextButton.addEventListener('click', () => {
        if (page * Number(pageSize.value) < total) {
            page++;
            void refresh({ seed: true });
        }
    });
    document.getElementById('systemLogClose').addEventListener('click', () => detailDialog.close());
    detailDialog.addEventListener('close', () => focusedBeforeDialog?.focus());
    detailDialog.addEventListener('click', event => {
        if (event.target === detailDialog) detailDialog.close();
    });
    for (const tab of document.querySelectorAll('.admin-tab')) {
        tab.addEventListener('click', () => {
            if (tab.dataset.tab === 'logs') enter();
            else suspend();
        });
    }
    document.addEventListener('visibilitychange', () => {
        if (document.hidden) suspend();
        else enter();
    });
    windowObject?.addEventListener('pagehide', () => {
        stopped = true;
        suspend();
    }, { once: true });

    return Object.freeze({
        refresh: () => refresh({ seed: true }),
        dispose() {
            stopped = true;
            suspend();
            detailDialog.close();
        }
    });
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { createAdminLogs };
} else {
    createAdminLogs({ document, fetch: window.fetch.bind(window) });
}
