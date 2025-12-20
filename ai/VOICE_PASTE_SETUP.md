# Voice Paste Setup - Production Ready

## What was fixed (2025-12-20):

### Problems:
1. **Server crashed silently** - Metal GPU encoder conflicts caused Flask to stop responding
2. **Zombie processes** - Server PID alive but not serving requests
3. **No cleanup on shutdown** - Multiple server instances could accumulate
4. **MLX model cache issues** - Potential for multiple model instances in memory

### Solutions:

#### 1. Server (`stt-server.py`):
- ✅ **PID file tracking** (`/tmp/stt-server.pid`) - reliable process management
- ✅ **Graceful shutdown** - SIGTERM/SIGINT handlers clean up properly
- ✅ **Single model instance** - `model_cache` flag prevents duplicate loads
- ✅ **Error logging** - All errors printed to `/tmp/stt-server.log`

#### 2. Hammerspoon (`~/.hammerspoon/init.lua`):
- ✅ **Health checks** - Verifies server responds to HTTP before declaring ready
- ✅ **Smart restart** - Kills stale processes if health check fails
- ✅ **Shutdown hook** - Kills server when Hammerspoon quits/reloads
- ✅ **PID-based killing** - Most reliable process termination

#### 3. Recording script (`vr-continuous`):
- ✅ **Retry logic** - 2 retries with 500ms backoff on HTTP failures
- ✅ **Timeout protection** - 10s max per request (prevents hangs)
- ✅ **Better error reporting** - Distinguishes between network and transcription errors

## Usage:

**Start/Reload Hammerspoon:**
```bash
# Reload config (kills old server, starts fresh)
Cmd+Ctrl+R
```

**Record voice:**
```bash
Cmd+,     # Auto-detect language, paste as-is
Cmd+.     # Translate to English, then paste
```

**Debug logs:**
```bash
tail -f /tmp/vr-debug.log        # Recording attempts
tail -f /tmp/stt-server.log      # Server startup/errors
```

**Manual server control:**
```bash
# Kill server
kill $(cat /tmp/stt-server.pid)

# Start manually (for testing)
python3 ~/xln/ai/stt-server.py
```

## Edge cases handled:

1. **Server crashes during transcription** → Retry 2x with backoff
2. **Hammerspoon reload** → Old server killed, new one started
3. **Mac shutdown** → Server cleaned up via shutdown hook
4. **Multiple Hammerspoon instances** → Each checks health, kills stale
5. **MLX GPU conflicts** → Single model instance + inference lock
6. **Network timeouts** → 10s max wait per request
7. **Empty responses** → Retry logic catches and retries

## Current status:

✅ **Production ready** - Run `Cmd+Ctrl+R` in Hammerspoon to activate new code.

## Files modified:
- `/Users/egor/xln/ai/stt-server.py` - Server with PID tracking and cleanup
- `/Users/egor/.hammerspoon/init.lua` - Health checks and shutdown hooks
- `/Users/egor/xln/ai/vr-continuous` - Retry logic and timeouts
