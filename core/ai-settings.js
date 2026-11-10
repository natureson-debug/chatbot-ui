'use strict';

// Application-supported subset of b11609 options, not a VRAM guarantee.
// Counts above a model's layer count are capped by llama.cpp at load time.
const LEGACY_AI_SETTINGS = Object.freeze({
    gpuLayers: 37, device: 'CUDA0', splitMode: 'layer', tensorSplit: null, verbosity: 4, metrics: false
});

function validateGpuSettings(settings, availableDevices) {
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
        throw Error('Invalid GPU settings');
    }

    if (typeof settings.device !== 'string') {
        throw Error('Select one or more available GPU devices');
    }
    let devices = settings.device.split(',').map(device => device.trim());
    if (devices.some(device => !/^[a-z0-9][a-z0-9_.:-]*$/i.test(device))) {
        throw Error('GPU devices must be selected from the available NVIDIA device list');
    }
    if (new Set(devices.map(device => device.toUpperCase())).size !== devices.length) {
        throw Error('A GPU device cannot be selected more than once');
    }
    if (Array.isArray(availableDevices)) {
        const available = new Map(availableDevices
            .map(device => typeof device === 'string' ? device : device?.id)
            .filter(device => typeof device === 'string')
            .map(device => [device.toUpperCase(), device]));
        const unavailable = devices.find(device => !available.has(device.toUpperCase()));
        if (unavailable) throw Error(`GPU device ${unavailable} is not available`);
        devices = devices.map(device => available.get(device.toUpperCase()));
    }

    const splitMode = settings.splitMode ?? 'layer';
    if (!['none', 'layer', 'row', 'tensor'].includes(splitMode)) {
        throw Error('Split mode must be none, layer, row, or tensor');
    }

    let tensorSplit = settings.tensorSplit ?? null;
    if (tensorSplit !== null) {
        if (typeof tensorSplit !== 'string') {
            throw Error('Tensor split must be comma-separated positive numbers');
        }
        tensorSplit = tensorSplit.trim();
        if (tensorSplit === '') {
            tensorSplit = null;
        } else {
            const proportions = tensorSplit.split(',').map(value => value.trim());
            if (proportions.some(value => !/^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value) ||
                !Number.isFinite(Number(value)) || Number(value) <= 0)) {
                throw Error('Tensor split must contain comma-separated positive numbers');
            }
            if (proportions.length !== devices.length) {
                throw Error('Tensor split must contain one proportion for each selected GPU');
            }
            tensorSplit = proportions.join(',');
        }
    }
    if (tensorSplit !== null && devices.length < 2) {
        throw Error('Tensor split requires at least two selected GPUs');
    }

    return { device: devices.join(','), devices, splitMode, tensorSplit };
}

function validateAiSettings(config, availableDevices) {
    if (!config || typeof config !== 'object' || Array.isArray(config)) throw Error('Invalid AI configuration');
    const result = { ...LEGACY_AI_SETTINGS, ...config };
    if (!Number.isInteger(result.gpuLayers) || result.gpuLayers < 0 || result.gpuLayers > 999) {
        throw Error('GPU layers must be an integer from 0 to 999');
    }
    const gpuSettings = validateGpuSettings(result, availableDevices);
    result.device = gpuSettings.device;
    result.splitMode = gpuSettings.splitMode;
    result.tensorSplit = gpuSettings.tensorSplit;
    if (!Number.isInteger(result.verbosity) || result.verbosity < 0 || result.verbosity > 5) {
        throw Error('Verbosity must be an integer from 0 to 5');
    }
    if (typeof result.metrics !== 'boolean') {
        throw Error('Metrics must be a boolean');
    }
    return result;
}

module.exports = { validateAiSettings, validateGpuSettings };
