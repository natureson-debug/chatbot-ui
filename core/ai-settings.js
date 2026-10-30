'use strict';

// Application-supported subset of b11609 options, not a VRAM guarantee.
// Counts above a model's layer count are capped by llama.cpp at load time.
const LEGACY_AI_SETTINGS = Object.freeze({ gpuLayers: 37, device: 'CUDA0', verbosity: 4, metrics: false });
function validateAiSettings(config) {
    if (!config || typeof config !== 'object' || Array.isArray(config)) throw Error('Invalid AI configuration');
    const result = { ...LEGACY_AI_SETTINGS, ...config };
    if (!Number.isInteger(result.gpuLayers) || result.gpuLayers < 0 || result.gpuLayers > 999) {
        throw Error('GPU layers must be an integer from 0 to 999');
    }
    if (result.device !== 'CUDA0') throw Error('Unsupported GPU device; use CUDA0');
    if (!Number.isInteger(result.verbosity) || result.verbosity < 0 || result.verbosity > 5) {
        throw Error('Verbosity must be an integer from 0 to 5');
    }
    if (typeof result.metrics !== 'boolean') {
        throw Error('Metrics must be a boolean');
    }
    return result;
}
module.exports = { validateAiSettings };
