'use strict';

/**
 * Graceful HTTP shutdown controller.
 *
 * Phase 2:
 * - Stop accepting connections.
 * - Wait for active HTTP requests.
 * - Close remaining HTTP connections after the grace period.
 * - Wait a bounded time for confirmed server closure.
 * - Report incomplete shutdown if confirmation never arrives.
 *
 * Does not close SQLite, terminate processes, or install
 * signal handlers.
 */

function createGracefulShutdown({
    server,
    gracePeriodMs = 15000,
    cleanupTimeoutMs = 2000,
    setTimer = setTimeout,
    clearTimer = clearTimeout
}) {
    if (!server || typeof server.close !== 'function') {
        throw new TypeError(
            'A server with a close() method is required'
        );
    }

    for (const [name, value] of [
        ['gracePeriodMs', gracePeriodMs],
        ['cleanupTimeoutMs', cleanupTimeoutMs]
    ]) {
        if (!Number.isSafeInteger(value) || value < 1) {
            throw new RangeError(
                `${name} must be a positive safe integer`
            );
        }
    }

    let shutdownPromise = null;
    let state = 'idle';

    function getState() {
        return state;
    }

    function shutdown() {
        if (shutdownPromise) {
            return shutdownPromise;
        }

        state = 'stopping';

        shutdownPromise = new Promise((resolve) => {
            let settled = false;
            let cleanupStarted = false;
            let timer = null;

            function clearCurrentTimer() {
                if (timer !== null) {
                    clearTimer(timer);
                    timer = null;
                }
            }

            function finish(result) {
                if (settled) return;

                settled = true;
                clearCurrentTimer();

                state = result.completed
                    ? 'stopped'
                    : 'incomplete';

                resolve(Object.freeze(result));
            }

            function onServerClosed(error) {
                if (settled) return;

                if (error) {
                    finish({
                        completed: false,
                        reason: 'server-close-error',
                        code: error.code || null
                    });
                    return;
                }

                finish({
                    completed: true,
                    reason: cleanupStarted
                        ? 'server-closed-after-cleanup'
                        : 'server-closed'
                });
            }

            function beginCleanup() {
                if (settled || cleanupStarted) return;

                cleanupStarted = true;
                state = 'cleaning-up';

                clearCurrentTimer();

                // Arm confirmation timeout before initiating
                // cleanup, including synchronous callbacks.
                try {
                    timer = setTimer(() => {
                        finish({
                            completed: false,
                            reason: 'cleanup-confirmation-expired'
                        });
                    }, cleanupTimeoutMs);
                } catch (error) {
                    finish({
                        completed: false,
                        reason: 'timer-setup-failed'
                    });
                    return;
                }

                if (
                    typeof server.closeAllConnections !== 'function'
                ) {
                    finish({
                        completed: false,
                        reason: 'connection-cleanup-unavailable'
                    });
                    return;
                }

                try {
                    server.closeAllConnections();
                } catch (error) {
                    finish({
                        completed: false,
                        reason: 'connection-cleanup-error',
                        code: error.code || null
                    });
                }
            }

            try {
                timer = setTimer(
                    beginCleanup,
                    gracePeriodMs
                );
            } catch (error) {
                finish({
                    completed: false,
                    reason: 'timer-setup-failed'
                });
                return;
            }

            try {
                server.close(onServerClosed);
            } catch (error) {
                finish({
                    completed: false,
                    reason: 'server-close-threw',
                    code: error.code || null
                });
            }
        });

        return shutdownPromise;
    }

    return Object.freeze({
        shutdown,
        getState
    });
}

module.exports = {
    createGracefulShutdown
};
