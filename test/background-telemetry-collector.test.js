'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { createBackgroundTelemetryCollector } = require('../core/background-telemetry-collector');

test('Background telemetry collector starts and stops', (t, done) => {
    let collectionCalls = 0;
    const mockStorage = {
        pollAndStore: async () => { collectionCalls++; }
    };
    const mockGetAdminTelemetry = async () => ({});

    const collector = createBackgroundTelemetryCollector(mockStorage, mockGetAdminTelemetry);
    assert(!collector.isActive());

    collector.start();
    assert(collector.isActive());

    // Wait for initial collection
    setTimeout(() => {
        assert(collectionCalls > 0);
        collector.stop();
        assert(!collector.isActive());
        done();
    }, 100);
});

test('Background telemetry collector catches collection errors', (t, done) => {
    let errorCount = 0;
    const mockStorage = {
        pollAndStore: async () => { throw new Error('Test error'); }
    };
    const mockGetAdminTelemetry = async () => ({});

    // Suppress console.error for test
    const originalError = console.error;
    console.error = () => { errorCount++; };

    const collector = createBackgroundTelemetryCollector(mockStorage, mockGetAdminTelemetry);
    collector.setIntervalMs(50);
    collector.start();

    setTimeout(() => {
        collector.stop();
        console.error = originalError;
        assert(errorCount > 0);
        done();
    }, 150);
});

test('Background telemetry collector can be stopped and restarted', (t, done) => {
    let calls = 0;
    const mockStorage = {
        pollAndStore: async () => { calls++; }
    };
    const mockGetAdminTelemetry = async () => ({});

    const collector = createBackgroundTelemetryCollector(mockStorage, mockGetAdminTelemetry);
    collector.setIntervalMs(50);

    collector.start();
    setTimeout(() => {
        collector.stop();
        const firstRound = calls;
        assert(firstRound > 0);

        setTimeout(() => {
            const afterStop = calls;
            assert.equal(firstRound, afterStop);

            collector.start();
            setTimeout(() => {
                collector.stop();
                assert(calls > afterStop);
                done();
            }, 100);
        }, 100);
    }, 100);
});
