'use strict';

function createGpuTelemetryCache() {
    let lastSample = null;
    let lastSampleTime = null;

    function setCachedSample(sample) {
        if (!sample || typeof sample !== 'object') return;
        lastSample = sample;
        lastSampleTime = Date.now();
    }

    function getCachedSample() {
        if (!lastSample) return null;

        // Return cached sample if less than 10 seconds old
        const ageMs = Date.now() - lastSampleTime;
        if (ageMs > 10000) return null;

        return {
            ...lastSample,
            cachedAgeMs: ageMs
        };
    }

    function isCacheStale() {
        if (!lastSample) return true;
        const ageMs = Date.now() - lastSampleTime;
        return ageMs > 10000;
    }

    return {
        setCachedSample,
        getCachedSample,
        isCacheStale
    };
}

module.exports = createGpuTelemetryCache;
