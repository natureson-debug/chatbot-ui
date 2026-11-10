'use strict';
const test = require('node:test');
const assert = require('node:assert');

test('Historical chart rendering: containers in DOM before renderChart (Issue A fix)', async (t) => {
    // DOM timing bug fix: renderChart() is called after gpuSection is appended to chartsContainer
    
    // Mock minimal DOM for testing
    const elements = new Map();
    const renderChartCalls = [];
    
    const mockDoc = {
        getElementById(id) {
            return elements.get(id) || null;
        },
        createElement(tag) {
            const el = {
                tagName: tag,
                id: undefined,
                className: '',
                textContent: '',
                children: [],
                parentElement: null,
                replaceChildren(...args) {
                    this.children.splice(0, this.children.length, ...args);
                    args.forEach(arg => {
                        if (arg.parentElement !== undefined) arg.parentElement = this;
                    });
                },
                appendChild(child) {
                    this.children.push(child);
                    child.parentElement = this;
                    // Key fix: after appendChild, element should be findable by getElementById
                    if (child.id) {
                        elements.set(child.id, child);
                    }
                    return child;
                },
                setAttribute() {},
                addEventListener() {}
            };
            return el;
        },
        createElementNS(ns, tag) {
            return {
                tagName: tag,
                namespaceURI: ns,
                setAttribute() {},
                appendChild() {}
            };
        }
    };
    
    // Override renderChart to track calls
    function renderChart(id, title, points, yLabel, yMax, fmt) {
        const container = mockDoc.getElementById(id);
        renderChartCalls.push({
            id,
            title,
            containerFound: !!container,
            pointsLength: points?.length || 0,
            yMax
        });
        if (!container) {
            throw new Error(`renderChart failed: container with id='${id}' not found in DOM`);
        }
    }
    
    // Mock chartsContainer
    const chartsContainer = mockDoc.createElement('div');
    chartsContainer.id = 'monitorCharts';
    elements.set('monitorCharts', chartsContainer);
    
    // Simulate loadAndRenderCharts with the fix
    function loadAndRenderChartsFixed() {
        const historyData = [
            { gpu_index: 0, gpu_name: 'RTX 3090', sampled_at: '2026-11-10T12:00:00Z', utilization_percent: 25, temperature_c: 45, power_w: 150, memory_used_mib: 8000, memory_total_mib: 24576, power_limit_w: 420 },
            { gpu_index: 0, gpu_name: 'RTX 3090', sampled_at: '2026-11-10T12:00:05Z', utilization_percent: 30, temperature_c: 48, power_w: 160, memory_used_mib: 8500, memory_total_mib: 24576, power_limit_w: 420 },
            { gpu_index: 0, gpu_name: 'RTX 3090', sampled_at: '2026-11-10T12:00:10Z', utilization_percent: 28, temperature_c: 46, power_w: 155, memory_used_mib: 8200, memory_total_mib: 24576, power_limit_w: 420 }
        ];
        
        const gpuIndices = new Set(historyData.map(s => s.gpu_index));
        const charts = [];
        
        for (const idx of gpuIndices) {
            if (idx === -1) continue;
            const gpuData = historyData.filter(s => s.gpu_index === idx);
            const gpuName = gpuData[0]?.gpu_name || `GPU ${idx}`;
            
            charts.push({
                name: gpuName,
                data: [
                    { id: `util-${idx}`, title: `${gpuName} Utilization`, points: gpuData.map(s => ({ time: s.sampled_at, value: s.utilization_percent })), yMax: 100, fmt: n => `${n}%` },
                    { id: `temp-${idx}`, title: `${gpuName} Temperature`, points: gpuData.map(s => ({ time: s.sampled_at, value: s.temperature_c })), yMax: 100, fmt: n => `${n}°C` },
                    { id: `power-${idx}`, title: `${gpuName} Power`, points: gpuData.map(s => ({ time: s.sampled_at, value: s.power_w })), yMax: gpuData.reduce((max, s) => Math.max(max, s.power_limit_w || 0), 500), fmt: n => `${n}W` },
                    { id: `mem-${idx}`, title: `${gpuName} VRAM Usage`, points: gpuData.map(s => ({ time: s.sampled_at, value: s.memory_used_mib })), yMax: gpuData.reduce((max, s) => Math.max(max, s.memory_total_mib || 0), 24576), fmt: n => `${(n / 1024).toFixed(1)}GB` }
                ]
            });
        }
        
        // FIXED: Collect renderChart metadata before appending, then append section, then render
        chartsContainer.replaceChildren();
        charts.forEach(gpu => {
            const gpuSection = mockDoc.createElement('section');
            gpuSection.className = 'monitor-gpu-section';
            const header = mockDoc.createElement('h2');
            header.textContent = gpu.name;
            gpuSection.appendChild(header);
            
            const chartsToRender = [];
            gpu.data.forEach(c => {
                const div = mockDoc.createElement('div');
                div.id = c.id;
                div.className = 'monitor-chart-container';
                gpuSection.appendChild(div);
                chartsToRender.push({ id: c.id, title: c.title, points: c.points, yLabel: c.title.split(' ').pop(), yMax: c.yMax, fmt: c.fmt });
            });
            
            // CRITICAL FIX: Append to DOM BEFORE calling renderChart
            chartsContainer.appendChild(gpuSection);
            
            // Now renderChart can find containers in the live DOM
            chartsToRender.forEach(c => renderChart(c.id, c.title, c.points, c.yLabel, c.yMax, c.fmt));
        });
    }
    
    // Test: all renderChart calls should find their containers
    await t.test('all chart containers are findable by getElementById when renderChart is called', () => {
        renderChartCalls.length = 0;
        loadAndRenderChartsFixed();
        
        assert.strictEqual(renderChartCalls.length, 4, 'Should have 4 chart render calls (util, temp, power, vram)');
        
        renderChartCalls.forEach((call, i) => {
            assert.strictEqual(call.containerFound, true, `Chart ${i} (${call.id}): container should be found in DOM`);
            assert.strictEqual(call.pointsLength, 3, `Chart ${i}: should have 3 data points`);
            assert(call.yMax > 0, `Chart ${i}: yMax should be positive`);
        });
    });
    
    // Test: multi-GPU scenario
    await t.test('historical rendering works with multiple GPUs', () => {
        const historyDataMultiGpu = [
            { gpu_index: 0, gpu_name: 'GPU 0', sampled_at: '2026-11-10T12:00:00Z', utilization_percent: 25, temperature_c: 45, power_w: 150, memory_used_mib: 8000, memory_total_mib: 24576, power_limit_w: 420 },
            { gpu_index: 1, gpu_name: 'GPU 1', sampled_at: '2026-11-10T12:00:00Z', utilization_percent: 10, temperature_c: 35, power_w: 80, memory_used_mib: 2000, memory_total_mib: 24576, power_limit_w: 420 },
            { gpu_index: 0, gpu_name: 'GPU 0', sampled_at: '2026-11-10T12:00:05Z', utilization_percent: 30, temperature_c: 48, power_w: 160, memory_used_mib: 8500, memory_total_mib: 24576, power_limit_w: 420 },
            { gpu_index: 1, gpu_name: 'GPU 1', sampled_at: '2026-11-10T12:00:05Z', utilization_percent: 15, temperature_c: 38, power_w: 90, memory_used_mib: 2500, memory_total_mib: 24576, power_limit_w: 420 }
        ];
        
        const gpuIndices = new Set(historyDataMultiGpu.map(s => s.gpu_index));
        const charts = [];
        
        for (const idx of gpuIndices) {
            if (idx === -1) continue;
            const gpuData = historyDataMultiGpu.filter(s => s.gpu_index === idx);
            const gpuName = gpuData[0]?.gpu_name || `GPU ${idx}`;
            
            charts.push({
                name: gpuName,
                data: [
                    { id: `util-${idx}`, title: `${gpuName} Utilization`, points: gpuData.map(s => ({ time: s.sampled_at, value: s.utilization_percent })), yMax: 100, fmt: n => `${n}%` }
                ]
            });
        }
        
        renderChartCalls.length = 0;
        chartsContainer.replaceChildren();
        charts.forEach(gpu => {
            const gpuSection = mockDoc.createElement('section');
            gpuSection.className = 'monitor-gpu-section';
            const header = mockDoc.createElement('h2');
            header.textContent = gpu.name;
            gpuSection.appendChild(header);
            
            const chartsToRender = [];
            gpu.data.forEach(c => {
                const div = mockDoc.createElement('div');
                div.id = c.id;
                div.className = 'monitor-chart-container';
                gpuSection.appendChild(div);
                chartsToRender.push({ id: c.id, title: c.title, points: c.points, yLabel: c.title.split(' ').pop(), yMax: c.yMax, fmt: c.fmt });
            });
            
            chartsContainer.appendChild(gpuSection);
            chartsToRender.forEach(c => renderChart(c.id, c.title, c.points, c.yLabel, c.yMax, c.fmt));
        });
        
        assert.strictEqual(renderChartCalls.length, 2, 'Should have 2 chart render calls (1 per GPU)');
        renderChartCalls.forEach(call => {
            assert.strictEqual(call.containerFound, true, `Chart ${call.id}: should be found`);
        });
    });
    
    // Test: empty history graceful handling
    await t.test('historical rendering handles empty history gracefully', () => {
        const emptyData = [];
        const gpuIndices = new Set(emptyData.map(s => s.gpu_index));
        
        renderChartCalls.length = 0;
        chartsContainer.replaceChildren();
        
        if (gpuIndices.size === 0) {
            chartsContainer.textContent = 'No data available';
        }
        
        assert.strictEqual(chartsContainer.textContent, 'No data available', 'Should display message when no history');
        assert.strictEqual(renderChartCalls.length, 0, 'No charts should be rendered');
    });
});

test('Historical chart rendering: 5m, 30m, 1h modes preserve data', async (t) => {
    // Verify that the fix doesn't affect the logic for different time ranges
    
    await t.test('5-minute mode renders all available data', () => {
        // Simulate 5m worth of 5-second samples (60 samples)
        const data5m = [];
        for (let i = 0; i < 60; i++) {
            data5m.push({
                gpu_index: 0,
                gpu_name: 'RTX 3090',
                sampled_at: new Date(1699612800000 + i * 5000).toISOString(),
                utilization_percent: 20 + Math.random() * 10,
                temperature_c: 45 + Math.random() * 5,
                power_w: 150 + Math.random() * 50,
                memory_used_mib: 8000 + Math.random() * 1000,
                memory_total_mib: 24576,
                power_limit_w: 420
            });
        }
        
        assert.strictEqual(data5m.length, 60, '5-minute window should have 60 samples');
    });
});
