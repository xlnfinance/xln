# XLN Voice Paste - Local Voice Transcription for macOS

100% local, privacy-focused voice-to-text that works everywhere on macOS.

## Features

- ✅ **100% Local** - Voice never leaves your Mac
- ✅ **Global Hotkeys** - Works in ANY app (browsers, editors, chats, etc.)
- ✅ **Multi-language** - English & Russian (easily extensible)
- ✅ **Apple Silicon Optimized** - Uses MLX Whisper for fast transcription
- ✅ **Automatic Paste** - Transcribed text appears where your cursor is
- ✅ **Full History** - All recordings saved to `~/records/`

## Quick Install

```bash
curl -fsSL https://raw.githubusercontent.com/YOUR_USERNAME/YOUR_GIST/main/install-voice-paste.sh | bash
```

Or download and inspect first:

```bash
curl -fsSL https://raw.githubusercontent.com/YOUR_USERNAME/YOUR_GIST/main/install-voice-paste.sh > install.sh
cat install.sh  # Review the script
chmod +x install.sh
./install.sh
```

## Requirements

- macOS with Apple Silicon (M1/M2/M3)
- ~4GB disk space for Whisper models (downloaded automatically on first use)

## Usage

After installation:

1. Launch Hammerspoon (installed automatically)
2. Grant Accessibility permissions when prompted

**Then anywhere on your Mac:**

- **Ctrl+E** - Hold, speak English, release → text appears
- **Ctrl+R** - Hold, speak Russian, release → text appears

Works in: browsers, text editors, chat apps, terminals, anywhere!

## What Gets Installed

The install script:

1. **Homebrew** (if not present)
2. **sox** - Audio recording tool
3. **Hammerspoon** - Global hotkey manager
4. **mlx-whisper** - Apple Silicon optimized Whisper transcription
5. Creates `~/vr-continuous` - Recording worker script
6. Creates `~/.hammerspoon/init.lua` - Hotkey configuration
7. Creates `~/records/` - Recordings directory

## Privacy

- ✅ All audio processing happens **locally on your Mac**
- ✅ No network requests to external servers
- ✅ No telemetry or analytics
- ✅ All recordings saved locally in `~/records/`
- ✅ You can inspect all code before running

## Customization

### Change Hotkeys

Edit `~/.hammerspoon/init.lua`:

```lua
-- Change Ctrl+E to Ctrl+V for English:
hs.hotkey.bind({"ctrl"}, "v", function()
    startRecording("English")
end, ...)

-- Add Spanish support with Ctrl+S:
hs.hotkey.bind({"ctrl"}, "s", function()
    startRecording("Spanish")
end, ...)
```

Then: Hammerspoon menu → Reload Config

### Supported Languages

Whisper supports 100+ languages. To add more:

1. Edit `~/.hammerspoon/init.lua` and add hotkey binding
2. Language names: English, Russian, Spanish, French, German, Chinese, Japanese, etc.

Full list: https://github.com/openai/whisper#available-models-and-languages

### Change Whisper Model

Edit `~/vr-continuous` and change model:

```bash
# Faster but less accurate:
--model mlx-community/whisper-medium-mlx

# Slower but more accurate (current):
--model mlx-community/whisper-large-v3-mlx
```

## Troubleshooting

### "Failed" notification appears

Check debug log:
```bash
tail -f /tmp/vr-debug.log
```

### No transcription appears

1. Check microphone permissions: System Settings → Privacy & Security → Microphone
2. Verify Hammerspoon has accessibility permissions
3. Restart Hammerspoon: Menu bar icon → Quit → Open again

### Cyrillic characters appear as "aaaa"

Already fixed in latest version (uses clipboard + Cmd+V instead of keystroke)

### Check if services are running

```bash
# Check sox:
which sox

# Check mlx_whisper:
which mlx_whisper
# Or:
ls ~/Library/Python/3.9/bin/mlx_whisper

# Check Hammerspoon:
ps aux | grep Hammerspoon
```

## Uninstall

```bash
# Remove Hammerspoon config
rm -rf ~/.hammerspoon/init.lua

# Remove worker script
rm ~/vr-continuous

# Keep recordings (or delete if you want):
# rm -rf ~/records

# Uninstall Hammerspoon (optional):
brew uninstall --cask hammerspoon

# Uninstall sox (optional):
brew uninstall sox

# Uninstall mlx-whisper (optional):
pip3 uninstall mlx-whisper
```

## Technical Details

### Architecture

```
User presses Ctrl+E/R
    ↓
Hammerspoon catches hotkey
    ↓
Launches ~/vr-continuous script with language
    ↓
sox records audio to ~/records/YYYY-MM-DD/HH-MM-SS.wav
    ↓
User releases hotkey
    ↓
Hammerspoon sends SIGTERM to script
    ↓
Script stops recording
    ↓
mlx-whisper transcribes audio (local MLX model)
    ↓
Text copied to clipboard
    ↓
Simulates Cmd+V to paste at cursor
```

### Files

- `~/vr-continuous` - Recording & transcription worker (bash script)
- `~/.hammerspoon/init.lua` - Hotkey bindings (Lua script)
- `~/records/YYYY-MM-DD/*.wav` - All recordings (never deleted)
- `/tmp/vr-debug.log` - Debug output
- `~/.cache/huggingface/` - Downloaded Whisper models

## Credits

- **Whisper** - OpenAI (model)
- **MLX Whisper** - Apple MLX team (Apple Silicon optimization)
- **Hammerspoon** - Global hotkeys on macOS
- **sox** - Audio recording

## License

MIT - Do whatever you want with it

## Contributing

Found a bug? Want to add a language? Open an issue or PR!

---

Built with ❤️ for privacy-conscious developers who want local voice transcription.
