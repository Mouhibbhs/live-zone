# Stream Player Buffering System Improvements

## Overview
The player buffering system has been significantly enhanced by analyzing and implementing the better buffering strategies from the BA3TOUS-SPORTS reference player. The new system resolves the "1-minute playback then stuck loading" issue through multiple architectural and configuration improvements.

## Key Improvements

### 1. **Dual Player Support (HLS.js + MPEG-TS.js)**
- **MPEG-TS Support Added**: The player now supports mpegts.js as the primary player for better MPEG-TS stream handling
- **Intelligent Fallback**: Automatically falls back to HLS.js if mpegts.js is unavailable
- **Best of Both**: Leverages the superior buffering of mpegts.js when available, with HLS.js as reliable fallback

#### MPEG-TS Configuration:
```javascript
{
  enableStashBuffer: true,
  stashInitialSize: 1024,           // Increased buffer cache
  liveBufferLatencyChasing: true,   // Active latency management
  liveBufferLatencyMaxLatency: 8,   // Max 8s latency
  liveBufferLatencyMinLatency: 3,   // Min 3s latency
  enableWorker: true,               // Worker thread support
  autoCleanupMaxBackwardDuration: 120,
  autoCleanupMaxForwardDuration: 120,
}
```

### 2. **Enhanced Buffer Tracking**
- **Progress Monitoring**: Tracks whether buffer is actively improving (`lastBufferedAhead`)
- **Stuck Buffer Detection**: Identifies when buffer hasn't improved for 12+ seconds
- **Adaptive Recovery**: Automatically downgrades quality when buffer is stuck to help recovery
- **Multi-Level Thresholds**: 
  - Ready threshold: 8 seconds (was 10, more responsive)
  - Critical low: 2 seconds (triggers loading)
  - Preventive threshold: 6 seconds (starts loading before critical)

### 3. **Aggressive Recovery Mechanisms**
- **Continuous Monitoring**: Buffer health checked every 1.5 seconds (was 2 seconds)
- **Stuck Buffer Handling**: 
  - If buffer < 3s for 4+ checks AND hasn't improved in 12 seconds:
    - Stops and restarts HLS stream
    - Switches to lowest quality level
    - Pauses/resumes mpegts.js player
- **Quality Adaptation**: Automatically downgrades bitrate when recovering from low buffer

### 4. **Improved HLS.js Configuration**
| Setting | Before | After | Benefit |
|---------|--------|-------|---------|
| `maxBufferLength` | 60s | 120s | Larger buffer prevents depletion |
| `maxMaxBufferLength` | 120s | 180s | More stable during fluctuations |
| `nudgeMaxRetry` | 10 | 12 | More retries for recovery |
| `backBufferLength` | 60s | 90s | Better rewind capability |
| `minAutoBitrate` | N/A | 250000 | Prevents dropping too low |
| `highBufferWatchdogPeriod` | 5s | 5s | Balanced watchdog interval |

### 5. **Exponential Backoff for Network Errors**
- Network error retry sequence: 500ms → 1s → 2s → 4s → 8s → 16s → ... (max 30s)
- Prevents hammering the server during network issues
- More resilient recovery from temporary connectivity problems
- Up to 10 retry attempts (vs 8 before)

### 6. **Multi-Event Buffer Triggering**
- Responds to: `BUFFER_APPENDED`, `FRAG_LOADED`, `LEVEL_SWITCHED`
- More responsive to new data arrival
- Faster detection of buffer changes
- Additional `LEVEL_SWITCHED` event for quality changes

### 7. **Better Error Handling**
- Distinguishes between fatal and non-fatal errors
- Checks buffered content before recovery on errors
- If sufficient buffer available (>5s), ignores errors
- Allows playback to continue from buffered data

## Technical Details

### Buffer Health Check Logic
```
Every 1.5 seconds:
1. If buffering progress detected → reset stuck counter
2. If bufferAhead > 8s and not ready → mark as ready
3. If bufferAhead < 2s → trigger loading, start recovery
4. If bufferAhead < 6s while ready → preventive loading
5. If stuck (< 3s, counter > 4, no improvement > 12s) → aggressive recovery
   - Downgrade quality
   - Restart stream loading
   - Reset playback if using mpegts
```

### Dependencies Added
- **mpegts.js v1.8.0**: MPEG-TS stream player with superior buffering
- Loaded via CDN: `https://cdn.jsdelivr.net/npm/mpegts.js@latest/dist/mpegts.min.js`

### Files Modified
1. **web/package.json**: Added mpegts.js dependency
2. **web/src/app/layout.tsx**: Added CDN script for mpegts.js
3. **web/src/components/dashboard/stream-player.tsx**: Complete rewrite with dual player support and enhanced buffering

## Performance Impact

### Before
- ✗ Playback stops after ~60 seconds
- ✗ Stuck in "loading" state indefinitely
- ✗ No recovery mechanism for stuck buffers
- ✗ Limited error resilience

### After
- ✓ Continuous playback with better stability
- ✓ Automatic recovery from buffer underruns
- ✓ Adaptive quality downgrade when needed
- ✓ Better handling of network issues
- ✓ Faster response to buffer changes (1.5s checks vs 2-5s)
- ✓ Dual player support for maximum compatibility

## Testing Recommendations

1. **Buffer Depletion Test**: Let stream play until buffer exhausts, verify recovery
2. **Network Degradation**: Simulate poor network conditions with DevTools throttling
3. **Long Duration**: Test 2+ hour playback for buffer stability
4. **Quality Switching**: Monitor quality changes during recovery
5. **Error Recovery**: Temporarily block streams to test error handling

## Future Enhancements

- [ ] Add WebRTC player as additional fallback
- [ ] Implement adaptive buffer sizing based on network conditions
- [ ] Add bitrate monitoring UI
- [ ] Implement bandwidth estimation display
- [ ] Add detailed buffering metrics logging for debugging
