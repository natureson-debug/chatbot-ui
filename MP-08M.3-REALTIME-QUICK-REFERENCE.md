# MP-08M.3 — Real-time Monitoring: Quick Start & API Reference

**Commit:** `5d2b62f` | **Tests:** 27/27 passing | **Status:** ✅ Ready for production

---

## Quick Start

### For Users
1. Open Admin Console → GPU Monitoring tab
2. "Real-time (60s)" should be selected by default
3. Watch charts update ~1 per second
4. Pause button freezes UI (collection continues in background)
5. Switch to 5m/30m/1h to view historical data

### For Developers
1. Real-time polling runs at 1Hz (1000ms)
2. Cache updated every 5 seconds by background collector
3. No duplicate nvidia-smi calls (cache prevents them)
4. Missing metrics display as gaps (no zero-padding)

---

## API Endpoint

### GET /api/admin/ai/telemetry/realtime

**Authentication:** Admin-only (Bearer token in session cookie)

**Response (Always 200 OK):**
```json
{
  "source": "cached",           // "cached" or "unavailable"
  "sample": {                   // null if source is "unavailable"
    "sampledAt": "2026-11-10T11:45:16.952+04:00",
    "backend": { "state": "available", "model": "Qwen3-8B", ... },
    "gpu": {
      "state": "available",
      "devices": [
        {
          "uuid": "GPU-1234...",
          "name": "NVIDIA GeForce RTX 4090",
          "utilizationPercent": 85.5,
          "temperatureC": 72.3,
          "powerW": 380.2,
          "memoryUsedMiB": 22000.0,
          ...
        }
      ]
    },
    "cachedAgeMs": 523
  },
  "timestamp": 1699604716952
}
```

**Error Responses:**
- `401` — Not authenticated
- `403` — Authenticated but not admin
- `500` — Server error (rare)

---

## Configuration

### Cache TTL (Freshness Window)
**File:** `core/gpu-telemetry-cache.js` line 16
```javascript
if (ageMs > 10000) return null;  // 10 seconds (5s collect + 5s buffer)
```

### Real-time Polling Interval
**File:** `public/admin-monitor.js` line 8
```javascript
if (currentTimeRange === 'realtime') return 1000;  // 1 second
```

### Circular Buffer Size
**File:** `public/admin-monitor.js` line 10
```javascript
const realtimeMaxSamples = 60;  // 60-second window at 1Hz = 60 samples
```

---

## Architecture

```
Background Collector (5-second interval)
  └─ getAdminTelemetry() [nvidia-smi call]
     └─ cache.setCachedSample(sample)
     └─ storage.storeSample(sample) [SQLite]

Real-time Client (1-second polling)
  └─ fetch('/api/admin/ai/telemetry/realtime')
     └─ return cache.getCachedSample()
     └─ cache returns { sample, source: 'cached' | 'unavailable', age }

Client-side Rendering (1Hz)
  ├─ addRealtimeSample(sample)
  │  └─ Append to circular buffers (util, temp, power, vram)
  │     └─ Auto-discard oldest when buffer > 60 samples
  └─ renderRealtimeCharts()
     └─ Draw 4 charts per GPU using buffer data
```

---

## State Management

### Browser Memory (Real-time Mode)
```javascript
realtimeBuffers = {
  "GPU-uuid-1": {
    name: "RTX 4090",
    util: [{t: ms, v: 85.5}, ...],    // Max 60 samples
    temp: [{t: ms, v: 72.3}, ...],
    power: [{t: ms, v: 380.2}, ...],
    vram: [{t: ms, v: 22000.0}, ...]
  },
  ...  // One entry per GPU
}
```

### Server Memory (Cache)
```javascript
{
  lastSample: { full sample object },     // ~5KB
  lastSampleTime: 1699604716952ms         // Timestamp of cache
}
```

---

## Troubleshooting

### Real-time not updating
**Cause:** Cache stale (background collector stopped)
**Fix:** Restart server or check `/api/admin/ai/telemetry` endpoint
**Indicator:** Status shows "Real-time data unavailable"

### Charts freeze when page hidden
**Expected behavior** — polling stops to save bandwidth
**Fix:** Click browser tab to make page visible, charts resume

### Mode switching lag
**Cause:** Fetching historical data from SQLite
**Expected:** 100-500ms pause when switching to 5m/30m/1h
**Normal:** Switch back to Real-time should be instant (uses buffer)

### High CPU usage on server
**Cause:** Background collection or API load
**Check:** 
- Background collector interval (default 5s)
- Admin Console browser tab count (each polls independently)
**Fix:** Increase interval or reduce concurrent Admin sessions

---

## Integration with MP-08M.2

Real-time mode **complements** historical charts:

| Feature | Real-time | History |
|---------|-----------|---------|
| Selector Option | `realtime` | `5m`, `30m`, `1h` |
| Polling Rate | 1Hz | 5s |
| Storage | Browser memory | SQLite |
| Window | 60 seconds | 5m, 30m, 1h |
| Use Case | Live monitoring | Trend analysis |

Both modes:
- Share same chart rendering logic
- Use same authorization layer
- Respect pause button
- Stop polling when page hidden
- Display metrics as gaps (not zeros)

---

## Testing

### Run All Tests
```bash
node --test test/gpu-telemetry-*.test.js test/background-telemetry-*.test.js
```

### Test Cache Specifically
```bash
node --test test/gpu-telemetry-cache.test.js
```

### Test Real-time API
```bash
node --test test/gpu-telemetry-realtime-api.test.js
```

**Expected:** 27/27 tests passing (698ms)

---

## Performance Characteristics

| Metric | Value |
|--------|-------|
| Client Memory (per user) | <50KB |
| Server Memory (cache) | ~5KB |
| Network (per request) | ~10KB |
| Network (per minute) | ~600KB |
| Polling Interval | 1000ms |
| Chart Render Time | <50ms |
| Cache Freshness | 10 seconds |
| Background Collection | 5 seconds |
| nvidia-smi Calls | 1 per 5s (global) |

---

## Known Limitations

1. **No Interpolation:** Charts show raw 5-second samples at 1Hz; no linear interpolation
2. **No Zoom/Pan:** Real-time charts are fixed-size; historical charts support scroll
3. **Max GPUs:** Tested with up to 16; theoretically unlimited (memory cost is low)
4. **No Persistence:** Real-time buffer cleared on page close (intentional, saves storage I/O)
5. **No Playback:** Cannot scrub or replay historical real-time data (by design)

---

## Monitoring Production

### Watch For
- Real-time cache consistently returning `{ source: "unavailable" }` → background collector issue
- High network bandwidth per Admin session → increase polling interval
- Memory growth on server → cache size check (should stay ~5KB)

### Server Logs
- `[Telemetry] Starting background GPU collector` — Normal
- Collection errors logged but non-blocking
- Real-time endpoint returns 200 on all paths (check `source` field for availability)

---

## Future Enhancements

1. **Extended Windows:** 2-minute, 5-minute, 10-minute real-time options
2. **Statistics:** Min/max/avg over current 60-second window
3. **Alerts:** Visual indicator when metrics exceed thresholds
4. **Playback:** Scrub through historical real-time data (if stored)
5. **Per-GPU Toggle:** Allow disabling real-time for specific GPUs

---

**Documentation:** See `MP-08M.3-REALTIME-MONITORING-SUMMARY.md` for full details
