'use strict';

function withHttpErrorBoundary(handler, { logError = () => console.error("HTTP_HANDLER_FAILED") } = {}) {
    if (typeof handler !== 'function') {
        throw new TypeError('handler must be a function');
    }

    if (typeof logError !== 'function') {
        throw new TypeError('logError must be a function');
    }

    return async function guardedHandler(req, res) {
        try {
            return await handler(req, res);
        } catch (error) {
            try { logError(error); } catch { /* Logging must not reject the request boundary. */ }

            if (res.destroyed || res.writableEnded) {
                return;
            }

            if (res.headersSent) {
                res.destroy();
                return;
            }

            res.writeHead(500, {
                'Content-Type': 'application/json; charset=utf-8'
            });
            res.end(JSON.stringify({
                error: 'Internal server error'
            }));
        }
    };
}

module.exports = {
    withHttpErrorBoundary
};
