'use strict';

function createDatabaseCleanup({ db }) {
    if (!db || typeof db.close !== 'function') {
        throw new TypeError(
            'A database with close() is required'
        );
    }

    let operation = null;
    let state = 'open';

    function getState() {
        return state;
    }

    function cleanup(shutdownResult) {
        if (
            !shutdownResult ||
            shutdownResult.completed !== true ||
            shutdownResult.safeForDatabaseClose !== true
        ) {
            return Promise.resolve(Object.freeze({
                completed: false,
                reason: 'shutdown-not-qualified'
            }));
        }

        if (operation) {
            return operation;
        }

        state = 'closing';

        operation = Promise.resolve().then(() => {
            try {
                db.close();

                state = 'closed';

                return Object.freeze({
                    completed: true,
                    reason: 'database-closed'
                });
            } catch (error) {
                state = 'incomplete';

                return Object.freeze({
                    completed: false,
                    reason: 'database-close-failed',
                    code: error.code || null
                });
            }
        });

        return operation;
    }

    return Object.freeze({
        cleanup,
        getState
    });
}

module.exports = {
    createDatabaseCleanup
};
