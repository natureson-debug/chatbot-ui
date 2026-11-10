const { test } = require('node:test');
const { strict: assert } = require('node:assert');
const createGpuTelemetryCache = require('../core/gpu-telemetry-cache');

test('GPU telemetry cache stores and retrieves samples', () => {
    const cache = createGpuTelemetryCache();
    
    const sample = {
        sampledAt: new Date().toISOString(),
        backend: { state: 'available' },
        gpu: { state: 'available', devices: [{ uuid: 'GPU-1', name: 'RTX 4090', utilizationPercent: 50 }] }
    };
    
    cache.setCachedSample(sample);
    const cached = cache.getCachedSample();
    
    assert(cached, 'Sample should be cached');
    assert.strictEqual(cached.backend.state, 'available', 'Backend state preserved');
    assert(cached.gpu.devices.length > 0, 'GPU devices preserved');
    assert(typeof cached.cachedAgeMs === 'number', 'Cache age tracked');
});

test('GPU telemetry cache is fresh immediately after setting', () => {
    const cache = createGpuTelemetryCache();
    
    const sample = {
        sampledAt: new Date().toISOString(),
        backend: { state: 'available' },
        gpu: { state: 'available', devices: [] }
    };
    
    cache.setCachedSample(sample);
    
    // Cache should be fresh (just set)
    assert(!cache.isCacheStale(), 'Cache should be fresh immediately after setting');
    const cached = cache.getCachedSample();
    assert(cached.cachedAgeMs < 100, 'Age should be very small');
});

test('GPU telemetry cache returns null for missing sample', () => {
    const cache = createGpuTelemetryCache();
    
    assert.strictEqual(cache.getCachedSample(), null, 'Should return null when no sample');
    assert(cache.isCacheStale(), 'Should report stale when empty');
});

test('GPU telemetry cache ignores invalid samples', () => {
    const cache = createGpuTelemetryCache();
    
    cache.setCachedSample(null);
    cache.setCachedSample(undefined);
    cache.setCachedSample('invalid');
    cache.setCachedSample(123);
    
    assert.strictEqual(cache.getCachedSample(), null, 'Should ignore invalid samples');
});

test('GPU telemetry cache tracks age correctly', (t) => {
    const cache = createGpuTelemetryCache();
    
    const sample = {
        sampledAt: new Date().toISOString(),
        backend: { state: 'available' },
        gpu: { state: 'available', devices: [] }
    };
    
    cache.setCachedSample(sample);
    const cached1 = cache.getCachedSample();
    assert(cached1.cachedAgeMs < 100, 'Fresh sample should have very low age');
});
