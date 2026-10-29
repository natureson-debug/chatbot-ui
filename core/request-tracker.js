'use strict';

/**
 * Tracks HTTP request-handler and response lifetimes.
 *
 * A request settles only after:
 * 1. Its handler has completed or rejected.
 * 2. Its response has finished or closed.
 *
 * This module does not cancel requests, close sockets,
 * close databases, or terminate processes.
 */

function createRequestTracker() {
    let active = 0;
    let draining = false;

    const waiters = new Set();

    function notifyIfIdle() {
        if (active !== 0) return;

        for (const resolve of waiters) {
            resolve();
        }

        waiters.clear();
    }

    function getActiveCount() {
        return active;
    }

    function isDraining() {
        return draining;
    }

    function beginDrain() {
        draining = true;
        notifyIfIdle();
    }

    function whenIdle() {
        if (active === 0) {
            return Promise.resolve();
        }

        return new Promise((resolve) => {
            waiters.add(resolve);
        });
    }

    function track(handler) {
        if (typeof handler !== 'function') {
            throw new TypeError(
                'handler must be a function'
            );
        }

        return function trackedHandler(req, res) {
            if (draining) {
                if (!res.headersSent && !res.destroyed) {
                    res.writeHead(503, {
                        'Content-Type': 'application/json',
                        'Connection': 'close'
                    });

                    res.end(JSON.stringify({
                        error: 'Server shutting down'
                    }));
                }

                return Promise.resolve();
            }

            active++;

            let handlerFinished = false;
            let responseFinished =
                Boolean(res.writableFinished || res.destroyed);

            let settled = false;

            function settleIfReady() {
                if (settled) return;

                if (!handlerFinished || !responseFinished) {
                    return;
                }

                settled = true;

                res.off('finish', onResponseFinished);
                res.off('close', onResponseFinished);

                active--;
                notifyIfIdle();
            }

            function onResponseFinished() {
                responseFinished = true;
                settleIfReady();
            }

            res.on('finish', onResponseFinished);
            res.on('close', onResponseFinished);

            let result;

            try {
                result = handler(req, res);
            } catch (error) {
                result = Promise.reject(error);
            }

            return Promise.resolve(result).then(
                (value) => {
                    handlerFinished = true;
                    settleIfReady();
                    return value;
                },
                (error) => {
                    handlerFinished = true;
                    settleIfReady();
                    throw error;
                }
            );
        };
    }

    return Object.freeze({
        track,
        beginDrain,
        whenIdle,
        getActiveCount,
        isDraining
    });
}

module.exports = {
    createRequestTracker
};
