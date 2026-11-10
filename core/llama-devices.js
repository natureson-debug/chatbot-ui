'use strict';

const { execFile, execFileSync } = require('node:child_process');
const { LLAMA_EXECUTABLE } = require('./paths');

const DEVICE_LINE = /^\s*(CUDA\d+):\s+(.+?)(?:\s+\(([\d,]+)\s+MiB,\s+[\d,]+\s+MiB free\))?\s*$/i;

function parseLlamaDevices(output) {
    if (typeof output !== 'string') throw new Error('Invalid llama.cpp device list');

    const devices = [];
    for (const line of output.split(/\r?\n/)) {
        const match = DEVICE_LINE.exec(line);
        if (!match) continue;

        const memoryMiB = match[3] ? Number(match[3].replace(/,/g, '')) : null;
        devices.push({
            id: match[1],
            name: match[2].trim(),
            memoryMiB: Number.isSafeInteger(memoryMiB) ? memoryMiB : null
        });
    }

    const ids = new Set();
    const uniqueDevices = devices.filter(device => {
        const key = device.id.toUpperCase();
        if (ids.has(key)) return false;
        ids.add(key);
        return true;
    });
    if (uniqueDevices.length === 0) throw new Error('No NVIDIA CUDA devices were reported');
    return uniqueDevices;
}

function listLlamaDevices() {
    return new Promise((resolve, reject) => {
        execFile(LLAMA_EXECUTABLE, ['--list-devices'], {
            encoding: 'utf8',
            timeout: 5000,
            maxBuffer: 64 * 1024,
            windowsHide: true
        }, (error, stdout) => {
            if (error) {
                reject(new Error('GPU devices could not be discovered'));
                return;
            }
            try {
                resolve(parseLlamaDevices(stdout));
            } catch (_) {
                reject(new Error('GPU devices could not be discovered'));
            }
        });
    });
}

function listLlamaDevicesSync() {
    try {
        return parseLlamaDevices(execFileSync(LLAMA_EXECUTABLE, ['--list-devices'], {
            encoding: 'utf8',
            timeout: 5000,
            maxBuffer: 64 * 1024,
            windowsHide: true
        }));
    } catch (_) {
        throw new Error('GPU devices could not be discovered');
    }
}

module.exports = { parseLlamaDevices, listLlamaDevices, listLlamaDevicesSync };
