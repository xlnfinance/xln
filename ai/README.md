# XLN Voice Paste

**100% local voice transcription for macOS**

Privacy-focused • No cloud • SOTA quality • 500-700ms latency

---

## Features

- 🎤 **Global hotkeys** - Work in any app
- 🔒 **100% local** - No data leaves your Mac
- ⚡ **Fast** - 500-700ms transcription (Whisper large-v3 MLX)
- 🌍 **Multilingual** - 99+ languages (auto-detect)
- 🔄 **Auto-restart** - Reliable LaunchAgent
- 📝 **Smart paste** - Atomic clipboard (no race conditions)

## Installation

```bash
# One-line install
curl -sSL https://raw.githubusercontent.com/.../install-voice-paste.sh | bash

# Or manual
cd ~/xln/ai
./install-voice-paste.sh
```

**Requirements:**
- Apple Silicon Mac (M1/M2/M3/M4)
- macOS 14.0+
- ~8GB free RAM

## Usage

| Hotkey | Action |
|--------|--------|
| **⌘ ,** (hold) | Record → Auto-detect language → Paste |
| **⌘ .** (hold) | Record → Translate to English → Paste |

**Workflow:**
1. Focus cursor where you want text
2. Hold hotkey
3. Speak (2-10 seconds)
4. Release hotkey
5. Text pastes automatically

## Architecture

```
Hammerspoon (hotkeys)
    ↓
vr-continuous (recording script)
    ↓
whisper-server.py (MLX HTTP API)
    ↓
AppleScript (atomic paste)
```

**Components:**
- `vr-continuous` - Recording + transcription script (78 lines)
- `whisper-server.py` - Flask HTTP server with pre-loaded model (74 lines)
- `~/.hammerspoon/init.lua` - Hotkey bindings (69 lines)
- `~/Library/LaunchAgents/com.xln.whisper.plist` - Auto-start config

**Total code:** ~220 lines

## Files

```
~/xln/ai/
├── vr-continuous          # Recording worker script
├── whisper-server.py      # HTTP API server
├── install-voice-paste.sh # One-click installer
└── README.md              # This file

~/records/YYYY-MM-DD/      # All recordings saved
/tmp/vr-debug.log          # Debug output
```

## Configuration

Server listens on `0.0.0.0:5001` (all interfaces, local network only).

**Change model:**
Edit `whisper-server.py` line 16:
```python
MODEL_PATH = "mlx-community/whisper-large-v3-mlx"
# Or: "mlx-community/whisper-turbo" (faster, less accurate)
```

**Change hotkeys:**
Edit `~/.hammerspoon/init.lua` lines 52-61.

## Performance

| Metric | Value |
|--------|-------|
| Transcription | 500-700ms |
| Model load time | 5-8s (startup only) |
| RAM usage | 7.5GB (persistent) |
| Languages | 99+ (auto-detect) |

## Troubleshooting

**"Server down" error:**
```bash
# Check server status
curl http://localhost:5001/

# Restart server
launchctl kickstart -k gui/$(id -u)/com.xln.whisper

# View logs
tail -50 /tmp/whisper.log
tail -50 /tmp/vr-debug.log
```

**Clipboard issues:**
- Code uses atomic AppleScript paste (no race conditions)
- If still glitchy: Reload Hammerspoon (⌘Q → reopen)

**Slow transcription:**
- First transcription after startup: ~2-3s (model warm-up)
- Subsequent: 500-700ms
- Check RAM usage: `ps aux | grep whisper-server`

## Remote Access (Tailscale)

Use from iPhone or another Mac via encrypted VPN:

```bash
# On server Mac
brew install --cask tailscale
sudo tailscale up

# Get Tailscale IP
tailscale ip -4
# Example: 100.64.1.5

# Server is now accessible at: http://100.64.1.5:5001
```

See `IPHONE-SHORTCUT.md` for iPhone Shortcuts setup.

## Privacy

✅ **100% local processing**
- Whisper model runs on your Mac
- No data sent to cloud
- All recordings saved locally (`~/records/`)

✅ **Network:**
- Server listens on local network only (no internet exposure)
- Use Tailscale for secure remote access (optional)

## Uninstall

```bash
# Stop and remove LaunchAgent
launchctl unload ~/Library/LaunchAgents/com.xln.whisper.plist
rm ~/Library/LaunchAgents/com.xln.whisper.plist

# Remove Hammerspoon config
rm ~/.hammerspoon/init.lua

# Remove scripts
rm ~/xln/ai/vr-continuous
rm ~/xln/ai/whisper-server.py

# Remove recordings (optional)
rm -rf ~/records/

# Uninstall dependencies
brew uninstall sox ffmpeg
brew uninstall --cask hammerspoon
pip3 uninstall mlx-whisper flask
```

## Credits

- **OpenAI Whisper** - Speech recognition model
- **Apple MLX** - ML framework for Apple Silicon
- **Hammerspoon** - macOS automation
- **SoX** - Audio recording

## License

MIT License - Free to use, modify, share.

---

**Built with 🎤 by XLN Team**
