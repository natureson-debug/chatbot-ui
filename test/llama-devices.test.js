'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseLlamaDevices } = require('../core/llama-devices');

test('parses CUDA device IDs, names and memory capacities', () => {
    assert.deepEqual(parseLlamaDevices([
        'Available devices:',
        '  CUDA0: NVIDIA GeForce RTX 3090 (24,575 MiB, 23,336 MiB free)',
        '  CUDA1: NVIDIA RTX 2000 Ada Generation (15,355 MiB, 14,292 MiB free)'
    ].join('\n')), [
        { id: 'CUDA0', name: 'NVIDIA GeForce RTX 3090', memoryMiB: 24575 },
        { id: 'CUDA1', name: 'NVIDIA RTX 2000 Ada Generation', memoryMiB: 15355 }
    ]);
});

test('allows a listed device without a reported capacity and rejects empty inventory', () => {
    assert.deepEqual(parseLlamaDevices('  CUDA4: NVIDIA GPU'), [
        { id: 'CUDA4', name: 'NVIDIA GPU', memoryMiB: null }
    ]);
    assert.throws(() => parseLlamaDevices('Available devices:\n  CPU: system'), /No NVIDIA CUDA devices/);
});

test('deduplicates device IDs case-insensitively', () => {
    assert.deepEqual(parseLlamaDevices([
        'CUDA0: NVIDIA GPU (100 MiB, 90 MiB free)',
        'cuda0: duplicate (100 MiB, 90 MiB free)'
    ].join('\n')), [{ id: 'CUDA0', name: 'NVIDIA GPU', memoryMiB: 100 }]);
});
