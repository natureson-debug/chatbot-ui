'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { createGpuTelemetryStorage } = require('../core/gpu-telemetry-storage');
const { createBackgroundTelemetryCollector } = require('../core/background-telemetry-collector');

test('Complete GPU telemetry collection and storage workflow', async () => {
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

    const storage = createGpuTelemetryStorage(db);
    let collectionCount = 0;

    const mockGetAdminTelemetry = async () => {
        collectionCount++;
        return {
            sampledAt: new Date().toISOString(),
            gpu: {
                state: 'available',
                devices: [
                    {
                        uuid: 'GPU-abc123',
                        name: 'NVIDIA RTX 3090',
                        driver: '610.88',
                        utilizationPercent: 20 + collectionCount * 5,
                        memoryUsedMiB: 10000 + collectionCount * 500,
                        memoryTotalMiB: 24576,
                        temperatureC: 50 + collectionCount * 2,
                        powerW: 200 + collectionCount * 10,
                        powerLimitW: 350
                    }
                ]
            },
            backend: {
                state: 'ready',
                model: 'test-model.gguf',
                contextPerSlot: 4096,
                parallelSlots: 1,
                metricsState: 'available',
                metrics: {
                    generatedTokensPerSecond: 45.5 + collectionCount * 2,
                    promptTokensPerSecond: 120 + collectionCount * 5
                },
                activeRequests: collectionCount % 3
            }
        };
    };

    const collector = createBackgroundTelemetryCollector(storage, mockGetAdminTelemetry);
    collector.setIntervalMs(50);

    // Start collecting
    collector.start();
    assert(collector.isActive());

    // Wait for a few collections
    await new Promise(resolve => setTimeout(resolve, 200));

    // Verify data was collected
    const rowCount = db.prepare('SELECT COUNT(*) as count FROM gpu_telemetry').get().count;
    assert(rowCount > 0);

    // Verify history retrieval
    const history = storage.getHistory(10 * 60 * 1000);
    assert(history.length > 0);
    
    // Verify backend entries are present
    const backendEntries = history.filter(h => h.gpu_index === -1);
    assert(backendEntries.length > 0);
    assert.equal(backendEntries[0].backend_state, 'ready');
    assert.equal(backendEntries[0].backend_model, 'test-model.gguf');

    // Verify GPU entries are present
    const gpuEntries = history.filter(h => h.gpu_index === 0);
    assert(gpuEntries.length > 0);
    assert.equal(gpuEntries[0].gpu_name, 'NVIDIA RTX 3090');
    assert(gpuEntries[0].utilization_percent > 0);

    // Verify increasing utilization trend (allowing for batching)
    assert(gpuEntries[gpuEntries.length - 1].utilization_percent >= gpuEntries[0].utilization_percent);

    // Get statistics
    const stats = storage.getStatistics(10 * 60 * 1000);
    assert(stats.total_samples > 0);
    assert(stats.distinct_times > 0);
    assert(stats.earliest_ms > 0);
    assert(stats.latest_ms >= stats.earliest_ms);

    // Stop collection
    collector.stop();
    assert(!collector.isActive());

    // Verify no more collections happen
    const collectionCountBefore = collectionCount;
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(collectionCount, collectionCountBefore);

    // Verify old records are pruned
    const twoHoursAgo = Date.now() - (2 * 60 * 60 * 1000);
    db.prepare(`
        INSERT INTO gpu_telemetry (sampled_at, sampled_at_unix_ms, gpu_index, gpu_uuid)
        VALUES (?, ?, ?, ?)
    `).run(new Date(twoHoursAgo - 3600000).toISOString(), twoHoursAgo - 3600000, 0, 'OLD');

    const countBefore = db.prepare('SELECT COUNT(*) as count FROM gpu_telemetry WHERE gpu_uuid = ?').get('OLD').count;
    assert.equal(countBefore, 1);

    storage.pruneOldSamples();

    const countAfter = db.prepare('SELECT COUNT(*) as count FROM gpu_telemetry WHERE gpu_uuid = ?').get('OLD').count;
    assert.equal(countAfter, 0);
});

test('GPU telemetry supports multiple GPU devices in history', async () => {
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

    const storage = createGpuTelemetryStorage(db);

    const mockGetAdminTelemetry = async () => ({
        sampledAt: new Date().toISOString(),
        gpu: {
            state: 'available',
            devices: [
                { uuid: 'GPU-1', name: 'RTX 3090', driver: '610', utilizationPercent: 40, memoryUsedMiB: 12000, memoryTotalMiB: 24576, temperatureC: 65, powerW: 250, powerLimitW: 350 },
                { uuid: 'GPU-2', name: 'RTX 4090', driver: '610', utilizationPercent: 75, memoryUsedMiB: 18000, memoryTotalMiB: 24576, temperatureC: 72, powerW: 320, powerLimitW: 575 }
            ]
        },
        backend: { state: 'ready', model: 'test.gguf' }
    });

    storage.storeSample(await mockGetAdminTelemetry());

    const history = storage.getHistory(10 * 60 * 1000);
    const gpu0 = history.filter(h => h.gpu_index === 0);
    const gpu1 = history.filter(h => h.gpu_index === 1);

    assert.equal(gpu0.length, 1);
    assert.equal(gpu1.length, 1);
    assert.equal(gpu0[0].gpu_name, 'RTX 3090');
    assert.equal(gpu1[0].gpu_name, 'RTX 4090');
    assert.equal(gpu0[0].utilization_percent, 40);
    assert.equal(gpu1[0].utilization_percent, 75);
});
