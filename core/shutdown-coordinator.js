'use strict';

function createShutdownCoordinator({
    requestTracker,
    gracefulShutdown,
    timeoutMs = 20000,
    setTimer = setTimeout,
    clearTimer = clearTimeout
}) {
    if (
        !requestTracker ||
        typeof requestTracker.beginDrain !== 'function' ||
        typeof requestTracker.whenIdle !== 'function' ||
        typeof requestTracker.getActiveCount !== 'function'
    ) {
        throw new TypeError('Valid requestTracker required');
    }

    if (
        !gracefulShutdown ||
        typeof gracefulShutdown.shutdown !== 'function'
    ) {
        throw new TypeError('Valid gracefulShutdown required');
    }

    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
        throw new RangeError('timeoutMs must be positive');
    }

    let operation = null;

    function shutdown() {
        if (operation) return operation;

        operation = new Promise((resolve) => {
            let settled = false;
            let timer = null;
            let httpResult = null;
            let requestsIdle = false;

            function finish(result) {
                if (settled) return;

                settled = true;

                if (timer !== null) {
                    clearTimer(timer);
                }

                resolve(Object.freeze(result));
            }

            function checkCompletion() {
                if (settled) return;

                if (httpResult && !httpResult.completed) {
                    finish({
                        completed: false,
                        safeForDatabaseClose: false,
                        reason: 'http-shutdown-incomplete'
                    });
                    return;
                }

                if (
                    httpResult &&
                    httpResult.completed &&
                    requestsIdle &&
                    requestTracker.getActiveCount() === 0
                ) {
                    finish({
                        completed: true,
                        safeForDatabaseClose: true,
                        reason: 'http-closed-and-requests-idle'
                    });
                }
            }

            try {
                timer = setTimer(() => {
                    finish({
                        completed: false,
                        safeForDatabaseClose: false,
                        reason: 'shutdown-deadline-expired'
                    });
                }, timeoutMs);
            } catch {
                finish({
                    completed: false,
                    safeForDatabaseClose: false,
                    reason: 'timer-setup-failed'
                });
                return;
            }

            try {
                requestTracker.beginDrain();
            } catch {
                finish({
                    completed: false,
                    safeForDatabaseClose: false,
                    reason: 'request-drain-failed'
                });
                return;
            }

            // Begin HTTP closure immediately after admission drain.
            let httpPromise;

            try {
                httpPromise = gracefulShutdown.shutdown();
            } catch {
                finish({
                    completed: false,
                    safeForDatabaseClose: false,
                    reason: 'http-shutdown-threw'
                });
                return;
            }

            Promise.resolve(httpPromise).then(
                (result) => {
                    if (settled) return;

                    httpResult = result;
                    try { checkCompletion(); } catch { finish({ completed: false, safeForDatabaseClose: false, reason: "completion-check-failed" }); }
                },
                () => {
                    finish({
                        completed: false,
                        safeForDatabaseClose: false,
                        reason: 'http-shutdown-rejected'
                    });
                }
            );

            try {
                Promise.resolve(requestTracker.whenIdle()).then(
                    () => {
                        if (settled) return;

                        requestsIdle = true;
                        try { checkCompletion(); } catch { finish({ completed: false, safeForDatabaseClose: false, reason: "completion-check-failed" }); }
                    },
                    () => {
                        finish({
                            completed: false,
                            safeForDatabaseClose: false,
                            reason: 'request-idle-rejected'
                        });
                    }
                );
            } catch {
                finish({
                    completed: false,
                    safeForDatabaseClose: false,
                    reason: 'request-idle-threw'
                });
            }
        });

        return operation;
    }

    return Object.freeze({ shutdown });
}

module.exports = {
    createShutdownCoordinator
};
