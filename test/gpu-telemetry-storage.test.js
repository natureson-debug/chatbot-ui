'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { createGpuTelemetryStorage } = require('../core/gpu-telemetry-storage');

function createTestDb() {
    const db = new DatabaseSync(':memory:');
    db.exec(`
        CREATE TABLE gpu_telemetry (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            sampled_at TEXT NOT NULL,
            sampled_at_unix_ms INTEGER NOT NULL,
            gpu_index INTEGER NOT NULL,
            gpu_uuid TEXT,
            gpu_name TEXT,
            driver TEXT,
            utilization_percent REAL,
            memory_used_mib REAL,
            memory_total_mib REAL,
            temperature_c REAL,
            power_w REAL,
            power_limit_w REAL,
            backend_state TEXT,
            backend_model TEXT,
            context_per_slot INTEGER,
            parallel_slots INTEGER,
            metrics_state TEXT,
            generated_tokens_per_second REAL,
            prompt_tokens_per_second REAL,
            active_requests INTEGER,
            CHECK (gpu_index >= -1 AND gpu_index < 16)
        );
        CREATE INDEX gpu_telemetry_time_idx ON gpu_telemetry(sampled_at_unix_ms DESC);
        CREATE INDEX gpu_telemetry_gpu_time_idx ON gpu_telemetry(gpu_index, sampled_at_unix_ms DESC);
    `);
    return db;
}

test('GPU telemetry storage stores GPU samples with all metrics', () => {
    const db = createTestDb();
    const storage = createGpuTelemetryStorage(db);

    const sample = {
        sampledAt: '2026-11-10T10:30:00.000Z',
        gpu: {
            state: 'available',
            devices: [
                {
                    uuid: 'GPU-12345',
                    name: 'RTX 3090',
                    driver: '610.88',
                    utilizationPercent: 45,
                    memoryUsedMiB: 12000,
                    memoryTotalMiB: 24576,
                    temperatureC: 65,
                    powerW: 250,
                    powerLimitW: 350
                }
            ]
        },
        backend: {
            state: 'ready',
            model: 'test-model.gguf',
            contextPerSlot: 4096,
            parallelSlots: 2,
            metricsState: 'available'
        }
    };

    const rowsInserted = storage.storeSample(sample);
    assert.equal(rowsInserted, 2); // 1 backend + 1 GPU

    const rows = db.prepare('SELECT * FROM gpu_telemetry ORDER BY gpu_index').all();
    assert.equal(rows.length, 2);

    // Backend entry (gpu_index = -1)
    const backend = rows[0];
    assert.equal(backend.gpu_index, -1);
    assert.equal(backend.backend_state, 'ready');
    assert.equal(backend.backend_model, 'test-model.gguf');
    assert.equal(backend.context_per_slot, 4096);

    // GPU entry (gpu_index = 0)
    const gpu = rows[1];
    assert.equal(gpu.gpu_index, 0);
    assert.equal(gpu.gpu_name, 'RTX 3090');
    assert.equal(gpu.utilization_percent, 45);
    assert.equal(gpu.temperature_c, 65);
    assert.equal(gpu.power_w, 250);
    assert.equal(gpu.memory_used_mib, 12000);
});

test('GPU telemetry storage handles null/unavailable values correctly', () => {
    const db = createTestDb();
    const storage = createGpuTelemetryStorage(db);

    const sample = {
        sampledAt: '2026-11-10T10:30:00.000Z',
        gpu: {
            state: 'available',
            devices: [
                {
                    uuid: 'GPU-12345',
                    name: 'RTX 3090',
                    driver: null,
                    utilizationPercent: null,
                    memoryUsedMiB: 12000,
                    memoryTotalMiB: 24576,
                    temperatureC: null,
                    powerW: null,
                    powerLimitW: null
                }
            ]
        },
        backend: { state: 'unavailable' }
    };

    const rowsInserted = storage.storeSample(sample);
    assert.equal(rowsInserted, 2);

    const gpu = db.prepare('SELECT * FROM gpu_telemetry WHERE gpu_index = 0').get();
    assert.equal(gpu.driver, null);
    assert.equal(gpu.utilization_percent, null);
    assert.equal(gpu.memory_used_mib, 12000); // Non-null value preserved
    assert.equal(gpu.temperature_c, null);
    assert.equal(gpu.power_w, null);
});

test('GPU telemetry storage stores multiple GPU devices', () => {
    const db = createTestDb();
    const storage = createGpuTelemetryStorage(db);

    const sample = {
        sampledAt: '2026-11-10T10:30:00.000Z',
        gpu: {
            state: 'available',
            devices: [
                { uuid: 'GPU-1', name: 'RTX 3090', driver: '610.88', utilizationPercent: 50, memoryUsedMiB: 12000, memoryTotalMiB: 24576, temperatureC: 65, powerW: 250, powerLimitW: 350 },
                { uuid: 'GPU-2', name: 'RTX 4090', driver: '610.88', utilizationPercent: 75, memoryUsedMiB: 18000, memoryTotalMiB: 24576, temperatureC: 72, powerW: 320, powerLimitW: 575 }
            ]
        },
        backend: { state: 'ready' }
    };

    storage.storeSample(sample);
    const rows = db.prepare('SELECT COUNT(*) as count FROM gpu_telemetry').get();
    assert.equal(rows.count, 3); // 1 backend + 2 GPUs
});

test('GPU telemetry getHistory retrieves time-series data', () => {
    const db = createTestDb();
    const storage = createGpuTelemetryStorage(db);

    const now = Date.now();
    for (let i = 0; i < 5; i++) {
        const sample = {
            sampledAt: new Date(now - (5 - i) * 60000).toISOString(),
            gpu: { state: 'available', devices: [{ uuid: 'GPU-1', name: 'RTX', driver: '610', utilizationPercent: 20 + i * 10, memoryUsedMiB: 10000, memoryTotalMiB: 24576, temperatureC: 50 + i, powerW: 100 + i * 20, powerLimitW: 350 }] },
            backend: { state: 'ready' }
        };
        storage.storeSample(sample);
    }

    const history = storage.getHistory(10 * 60 * 1000); // 10 minute range
    assert(history.length >= 5);
    assert.equal(history[0].gpu_index, -1); // First should be backend sentinel
});

test('GPU telemetry getStatistics returns correct summary', () => {
    const db = createTestDb();
    const storage = createGpuTelemetryStorage(db);

    const now = Date.now();
    for (let i = 0; i < 3; i++) {
        storage.storeSample({
            sampledAt: new Date(now - (3 - i) * 60000).toISOString(),
            gpu: { state: 'available', devices: [{ uuid: 'GPU-1', name: 'RTX', driver: '610', utilizationPercent: 50, memoryUsedMiB: 12000, memoryTotalMiB: 24576, temperatureC: 65, powerW: 250, powerLimitW: 350 }] },
            backend: { state: 'ready' }
        });
    }

    const stats = storage.getStatistics(10 * 60 * 1000);
    assert(stats.total_samples >= 6); // 3 * 2 (backend + GPU)
    assert.equal(stats.distinct_times, 3);
    assert(stats.earliest_ms > 0);
    assert(stats.latest_ms > stats.earliest_ms);
});

test('GPU telemetry pruneOldSamples removes records older than 2 hours', () => {
    const db = createTestDb();
    const storage = createGpuTelemetryStorage(db);

    // Insert old record (3 hours ago)
    const threeHoursAgo = Date.now() - (3 * 60 * 60 * 1000);
    db.prepare(`
        INSERT INTO gpu_telemetry (sampled_at, sampled_at_unix_ms, gpu_index, gpu_name, utilization_percent)
        VALUES (?, ?, ?, ?, ?)
    `).run(new Date(threeHoursAgo).toISOString(), threeHoursAgo, 0, 'RTX', 50);

    // Insert recent record (30 min ago)
    const thirtyMinAgo = Date.now() - (30 * 60 * 1000);
    db.prepare(`
        INSERT INTO gpu_telemetry (sampled_at, sampled_at_unix_ms, gpu_index, gpu_name, utilization_percent)
        VALUES (?, ?, ?, ?, ?)
    `).run(new Date(thirtyMinAgo).toISOString(), thirtyMinAgo, 0, 'RTX', 50);

    let total = db.prepare('SELECT COUNT(*) as count FROM gpu_telemetry').get().count;
    assert.equal(total, 2);

    storage.pruneOldSamples();

    total = db.prepare('SELECT COUNT(*) as count FROM gpu_telemetry').get().count;
    assert.equal(total, 1); // Old record pruned, recent record remains
});

test('GPU telemetry pollAndStore integration', async () => {
    const db = createTestDb();
    const storage = createGpuTelemetryStorage(db);

    let callCount = 0;
    const mockGetAdminTelemetry = async () => {
        callCount++;
        return {
            sampledAt: new Date().toISOString(),
            gpu: { state: 'available', devices: [{ uuid: 'GPU-1', name: 'RTX', driver: '610', utilizationPercent: 50, memoryUsedMiB: 12000, memoryTotalMiB: 24576, temperatureC: 65, powerW: 250, powerLimitW: 350 }] },
            backend: { state: 'ready', model: 'test.gguf' }
        };
    };

    const rowsA = await storage.pollAndStore(mockGetAdminTelemetry);
    assert.equal(rowsA, 2);
    assert.equal(callCount, 1);

    // Second call within interval should skip
    const rowsB = await storage.pollAndStore(mockGetAdminTelemetry);
    assert.equal(rowsB, 0); // Rate-limited
    assert.equal(callCount, 1);
});

test('GPU telemetry handles empty GPU list gracefully', () => {
    const db = createTestDb();
    const storage = createGpuTelemetryStorage(db);

    const sample = {
        sampledAt: '2026-11-10T10:30:00.000Z',
        gpu: { state: 'unavailable', devices: [] },
        backend: { state: 'ready' }
    };

    const rowsInserted = storage.storeSample(sample);
    assert.equal(rowsInserted, 1); // Only backend

    const rows = db.prepare('SELECT * FROM gpu_telemetry').all();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].gpu_index, -1);
});

test('GPU telemetry stores inference metrics', () => {
    const db = createTestDb();
    const storage = createGpuTelemetryStorage(db);

    const sample = {
        sampledAt: '2026-11-10T10:30:00.000Z',
        gpu: { state: 'available', devices: [{ uuid: 'GPU-1', name: 'RTX', driver: '610', utilizationPercent: 50, memoryUsedMiB: 12000, memoryTotalMiB: 24576, temperatureC: 65, powerW: 250, powerLimitW: 350 }] },
        backend: {
            state: 'ready',
            model: 'test.gguf',
            metricsState: 'available',
            metrics: {
                generatedTokensPerSecond: 45.5,
                promptTokensPerSecond: 120.3
            },
            activeRequests: 2
        }
    };

    storage.storeSample(sample);

    const backend = db.prepare('SELECT * FROM gpu_telemetry WHERE gpu_index = -1').get();
    assert.equal(backend.generated_tokens_per_second, 45.5);
    assert.equal(backend.prompt_tokens_per_second, 120.3);
    assert.equal(backend.active_requests, 2);
});
