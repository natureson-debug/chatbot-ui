'use strict';

function createLifecycleOrchestrator({
    shutdownCoordinator,
    databaseCleanup
}) {
    if (
        !shutdownCoordinator ||
        typeof shutdownCoordinator.shutdown !== 'function'
    ) {
        throw new TypeError(
            'A shutdown coordinator with shutdown() is required'
        );
    }

    if (
        !databaseCleanup ||
        typeof databaseCleanup.cleanup !== 'function'
    ) {
        throw new TypeError(
            'A database cleanup controller with cleanup() is required'
        );
    }

    let operation = null;
    let state = 'idle';

    function getState() {
        return state;
    }

    async function execute() {
        let shutdownResult;

        try {
            shutdownResult = await shutdownCoordinator.shutdown();
        } catch {
            state = 'incomplete';

            return Object.freeze({
                completed: false,
                databaseClosed: false,
                reason: 'shutdown-coordinator-failed'
            });
        }

        if (
            !shutdownResult ||
            shutdownResult.completed !== true ||
            shutdownResult.safeForDatabaseClose !== true
        ) {
            state = 'incomplete';

            return Object.freeze({
                completed: false,
                databaseClosed: false,
                reason: 'shutdown-not-qualified'
            });
        }

        state = 'closing-database';

        let cleanupResult;

        try {
            cleanupResult = await databaseCleanup.cleanup(shutdownResult);
        } catch {
            state = 'incomplete';

            return Object.freeze({
                completed: false,
                databaseClosed: false,
                reason: 'database-cleanup-failed'
            });
        }

        if (!cleanupResult || cleanupResult.completed !== true) {
            state = 'incomplete';

            return Object.freeze({
                completed: false,
                databaseClosed: false,
                reason: 'database-cleanup-incomplete'
            });
        }

        state = 'completed';

        return Object.freeze({
            completed: true,
            databaseClosed: true,
            reason: 'http-and-database-closed'
        });
    }

    function shutdown() {
        if (!operation) {
            state = 'stopping-http';
            operation = execute();
        }

        return operation;
    }

    return Object.freeze({
        shutdown,
        getState
    });
}

module.exports = {
    createLifecycleOrchestrator
};
