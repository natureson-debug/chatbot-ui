'use strict';

function createBackgroundTelemetryCollector(storage, getAdminTelemetry, cache) {
    let timer = null, isRunning = false, collectionIntervalMs = 5000;

    async function collect() {
        try {
            const sample = await getAdminTelemetry();
            if (cache) cache.setCachedSample(sample);
            await storage.pollAndStore(async () => sample);
        } catch (error) {
            console.error('Background telemetry collection failed:', error.message);
        }
    }

    function start() {
        if (isRunning) return;
        isRunning = true;
        console.log(`[Telemetry] Starting background GPU collector (${collectionIntervalMs}ms interval)`);

        // Initial collection
        collect().catch(error => console.error('Initial telemetry collection error:', error));

        // Schedule recurring collection
        timer = setInterval(() => {
            collect().catch(error => console.error('Periodic telemetry collection error:', error));
        }, collectionIntervalMs);

        // Prevent Node.js from waiting for this timer
        if (timer.unref) timer.unref();
    }

    function stop() {
        if (!isRunning) return;
        isRunning = false;
        if (timer) {
            clearInterval(timer);
            timer = null;
        }
        console.log('[Telemetry] Stopped background GPU collector');
    }

    function isActive() {
        return isRunning;
    }

    return { start, stop, isActive, setIntervalMs: (ms) => { collectionIntervalMs = Math.max(1000, ms); } };
}

module.exports = { createBackgroundTelemetryCollector };
