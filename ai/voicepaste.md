# Voice Paste - Local Voice Transcription

## Goal
100% local voice-to-text system that:
- Works globally across all macOS apps
- Privacy-focused (no data leaves Mac)
- Fast transcription (~500ms with MLX)
- Auto-detect Russian/English + translate option

## Current Status: WORKING ✅

**Speed:** 500-700ms (HTTP mode) | 2000-3000ms (CLI fallback)
**Privacy:** 100% local (mlx-whisper + MLX model)
**Accuracy:** Excellent (whisper-large-v3-mlx)

## How It Works

```
Hold Cmd+, → sox records → release → SIGTERM → mlx transcribes → paste
```

**Components:**
1. **Hammerspoon** (`~/.hammerspoon/init.lua`) - Global hotkeys
2. **vr-continuous** (`~/vr-continuous`) - Recording worker script
3. **whisper-server.py** (`~/xln/ai/whisper-server.py`) - Flask HTTP API
4. **Recordings** (`~/records/YYYY-MM-DD/`) - All audio saved permanently

## Hotkeys

- **Cmd+,** = Hold to record (auto-detect RU/EN)
- **Cmd+.** = Hold to record (translate to English)

## What Works

✅ Recording with sox
✅ MLX Whisper transcription (accurate)
✅ HTTP server mode (fast 500-700ms)
✅ Auto-detect Russian/English
✅ Translation to English
✅ Parallel processing (can record next while transcribing previous)
✅ Clipboard preservation (saves old clipboard, pastes, restores)
✅ All recordings saved to ~/records/

## Known Issues

### 1. Intermittent Paste Failure
**Symptom:** Sometimes pastes correctly, sometimes selects all (Cmd+A behavior)
**Cause:** Clipboard race condition - Cmd+V sent before clipboard ready
**Current fix:** Verification loop (10×50ms), but not 100% reliable
**Need:** Better clipboard sync or different paste method

### 2. SIGTERM Handling
**Symptom:** Error 15 or 143 when releasing hotkey
**Cause:** Bash script exits on SIGTERM instead of continuing to transcription
**Current fix:** Subshell with TERM trap - works but fragile
**Workaround:** Script in ~/vr-continuous uses minimal trap handling

### 3. HTTP Server Startup
**Symptom:** HTTP server not always auto-starting from Hammerspoon
**Solution:** Manually start server: `python3 ~/xln/ai/whisper-server.py &`
**Need:** Reliable auto-start mechanism (LaunchAgent?)

### 4. ffmpeg Dependency
**Symptom:** Flask server needs ffmpeg, sometimes returns 500 error
**Status:** Sometimes works without it, sometimes fails
**Action:** Install if needed: `brew install ffmpeg`

## Performance

**HTTP Mode (when server running):**
- Model pre-loaded in RAM: 6.4GB
- Transcription: ~500-700ms
- Total (record+transcribe+paste): ~1000-1500ms

**CLI Mode (fallback - DISABLED):**
- Loads model each time: ~5000ms overhead
- Not used anymore - fails if server down

## Files

```
~/.hammerspoon/init.lua       # Hotkey config (55 lines)
~/vr-continuous               # Worker script (26 lines)
~/xln/ai/whisper-server.py    # Flask HTTP API (65 lines)
~/records/                    # All recordings (never deleted)
/tmp/vr-debug.log            # Debug output (when enabled)
~/.xln-voice-config.json     # Config (unused currently)
```

## Installation for New Users

```bash
# 1. Install dependencies
brew install sox hammerspoon
pip3 install mlx-whisper flask

# 2. Create files
# - Copy ~/vr-continuous
# - Copy ~/.hammerspoon/init.lua
# - Copy ~/xln/ai/whisper-server.py

# 3. Start Hammerspoon
open -a Hammerspoon

# 4. Start whisper server
python3 ~/xln/ai/whisper-server.py &

# 5. Use hotkeys
# Cmd+, or Cmd+.
```

## Optimization Ideas

### Speed
- [x] Pre-load model in HTTP server (DONE - 500ms)
- [ ] Use whisper-turbo model (smaller, 2x faster)
- [ ] Optimize Flask (use gunicorn instead of dev server)
- [ ] Stream audio to server while recording (parallel record+transcribe)

### Reliability
- [ ] Fix clipboard race condition (100% success rate needed)
- [ ] Better SIGTERM handling (no more error 15)
- [ ] LaunchAgent for whisper server auto-start
- [ ] Health check - auto-restart server if crashes

### UX
- [ ] Single hotkey instead of two (Cmd+Space auto-detect)
- [ ] Visual feedback in menubar (recording indicator)
- [ ] Notification sound when pasted
- [ ] Show transcription preview before pasting

## Remote Access (Future)

User wants to use from another Mac in another city:
- Tailscale VPN (secure, encrypted)
- Expose http://mac-name.tailnet:5001/transcribe
- Same hotkeys work, but hits remote server
- Need auth/rate limiting for security

## Debugging

**Check if server running:**
```bash
curl http://localhost:5001/
# Should return: {"status":"ok","model":"..."}

ps aux | grep whisper-server
# Should show Python process ~6.4GB RAM
```

**Check latest transcription:**
```bash
tail -20 /tmp/vr-debug.log
```

**Test HTTP endpoint:**
```bash
curl -X POST http://localhost:5001/transcribe \
  -F "file=@~/records/2025-12-11/test.wav" \
  -F "task=transcribe"
```

**Common errors:**
- Error 2 = No audio recorded (sox failed)
- Error 3 = Empty transcription (silence or too short)
- Error 4 = Server down (HTTP request failed)
- Error 15/143 = SIGTERM killed script (trap failed)

## What NOT to Do

❌ Don't add CLI fallback (loads model every time, 3000ms)
❌ Don't use complex error handling (just fail fast)
❌ Don't add mode switching (toggle vs hold) - confusing
❌ Don't try to use Fn key (macOS doesn't support it)
❌ Don't use F1/F2 (conflicts with system shortcuts)
❌ Don't add debug logging everywhere (slows down)

## Working Example from Today

User transcribed multiple phrases successfully:
```
"Привет, как дела? Что произошло?"
"Hello, how are you doing?"
"По-русски говорю"
"В общем, это история, как я планирую купить усилитель"
```

All transcribed correctly in both languages with auto-detect.

## Next Session Priority

1. Fix clipboard paste (Cmd+A bug) - CRITICAL
2. Ensure whisper server auto-starts reliably
3. Add timing display (show whisper ms in notification)
4. Test remote access via Tailscale
5. Create one-line install script for new users

## Code Simplicity Principle

**Final working version:**
- Hammerspoon: 55 lines
- vr-continuous: 26 lines
- whisper-server: 65 lines
- **Total: 146 lines**

Keep it minimal. No fancy features. Just works.
