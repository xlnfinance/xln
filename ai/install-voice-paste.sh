#!/bin/bash
# XLN Voice Paste - Universal Installer
# 100% local voice transcription for macOS
# Supports: Whisper (quality) or Parakeet (speed)

set -e

echo "╔══════════════════════════════════════════════════════════════════╗"
echo "║         XLN Voice Paste - Local Voice Transcription             ║"
echo "╚══════════════════════════════════════════════════════════════════╝"
echo ""

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

# Check Apple Silicon
ARCH=$(uname -m)
if [ "$ARCH" != "arm64" ]; then
    echo "${RED}❌ Requires Apple Silicon (M1/M2/M3/M4)${NC}"
    exit 1
fi
echo "${GREEN}✓ Apple Silicon detected${NC}"

# Check/Install Homebrew
if ! command -v brew &> /dev/null; then
    echo "${YELLOW}→ Installing Homebrew...${NC}"
    /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
else
    echo "${GREEN}✓ Homebrew installed${NC}"
fi

# Install dependencies
echo "${YELLOW}→ Installing dependencies...${NC}"
brew install sox ffmpeg 2>&1 | grep -v "already installed" || true
brew install --cask hammerspoon 2>&1 | grep -v "already installed" || true
echo "${GREEN}✓ Dependencies installed${NC}"

# Ask model choice
echo ""
echo "Choose STT model:"
echo "  1) Whisper-large-v3 (best quality, 7.5GB RAM, ~700ms)"
echo "  2) Parakeet 0.6B (60x faster, 2GB RAM, ~15ms, 25 languages)"
echo ""
read -p "Choice [1/2]: " MODEL_CHOICE

# Install Flask (required for HTTP server)
echo "${YELLOW}→ Installing Flask...${NC}"
pip3 install flask
echo "${GREEN}✓ Flask installed${NC}"

if [ "$MODEL_CHOICE" = "2" ]; then
    MODEL="parakeet"
    echo "${YELLOW}→ Installing Parakeet-MLX...${NC}"
    pip3 install parakeet-mlx -U
    echo "${GREEN}✓ Parakeet installed${NC}"
else
    MODEL="whisper"
    echo "${YELLOW}→ Installing MLX-Whisper...${NC}"
    pip3 install mlx-whisper
    echo "${GREEN}✓ MLX-Whisper installed${NC}"
fi

# Create directories
mkdir -p ~/records
echo "${GREEN}✓ Created ~/records${NC}"

# Create vr-continuous script
echo "${YELLOW}→ Creating vr-continuous script...${NC}"
cat > ~/xln/ai/vr-continuous << 'EOFSCRIPT'
#!/bin/bash
export PATH="/opt/homebrew/bin:/Users/$(whoami)/Library/Python/3.9/bin:/usr/bin:$PATH"
export LANG=en_US.UTF-8

LOG="/tmp/vr-debug.log"
echo "=== $(date '+%H:%M:%S') START ===" >> "$LOG"

LANG_ARG="${1:-auto}"
AUDIO=~/records/$(date +%Y-%m-%d)/$(date +%H-%M-%S).wav
mkdir -p $(dirname "$AUDIO")
echo "File: $AUDIO" >> "$LOG"

# Trap SIGTERM BEFORE starting rec (prevents race condition)
trap 'echo "Got TERM, sending INT to background jobs" >> "$LOG"; kill -INT $(jobs -p) 2>/dev/null' TERM

# Record in background
rec "$AUDIO" rate 16k channels 1 2>/dev/null &
REC_PID=$!
echo "Recording PID: $REC_PID" >> "$LOG"

# Wait for rec
wait $REC_PID 2>/dev/null
REC_EXIT=$?
echo "rec exit code: $REC_EXIT" >> "$LOG"

# Give rec time to flush file
sleep 0.3

# Check audio exists
if [ ! -s "$AUDIO" ]; then
    echo "ERROR: No audio file" >> "$LOG"
    exit 2
fi

SIZE=$(stat -f%z "$AUDIO" 2>/dev/null || echo 0)
echo "Audio size: $SIZE bytes" >> "$LOG"

# Transcribe via HTTP
START=$(python3 -c "import time; print(int(time.time()*1000))")
TEXT=""

echo "Trying HTTP transcribe..." >> "$LOG"
if RES=$(curl -sf http://localhost:5001/transcribe -F "file=@$AUDIO" -F "task=$([ "$LANG_ARG" = "translate-en" ] && echo translate || echo transcribe)" 2>&1); then
    TEXT=$(echo "$RES" | python3 -c "import sys,json; print(json.load(sys.stdin).get('text',''))" 2>/dev/null)
    echo "HTTP result: $TEXT" >> "$LOG"
else
    echo "ERROR: HTTP server failed (curl exit $?)" >> "$LOG"
    exit 4
fi

MS=$(( $(python3 -c "import time; print(int(time.time()*1000))") - START ))
echo "Transcribe time: ${MS}ms" >> "$LOG"

# Paste
if [ -z "$TEXT" ]; then
    echo "ERROR: Empty text" >> "$LOG"
    exit 3
fi

echo "Pasting: $TEXT" >> "$LOG"

# Save old clipboard
OLD_CLIP=$(pbpaste 2>/dev/null || echo "")

# Copy new text
printf "%s" "$TEXT" | pbcopy

# Wait for clipboard to update
VERIFIED=false
for i in {1..15}; do
    CURRENT=$(pbpaste 2>/dev/null)
    if [ "$CURRENT" = "$TEXT" ]; then
        VERIFIED=true
        echo "Clipboard verified after ${i}00ms" >> "$LOG"
        break
    fi
    sleep 0.1
done

if [ "$VERIFIED" = false ]; then
    echo "ERROR: Clipboard verification failed" >> "$LOG"
    exit 8
fi

# Extra safety delay before paste
sleep 0.15

# Paste
osascript -e 'tell application "System Events" to keystroke "v" using command down' 2>/dev/null

echo "SUCCESS: ${MS}ms" >> "$LOG"
echo "$MS"
EOFSCRIPT

chmod +x ~/xln/ai/vr-continuous
echo "${GREEN}✓ Created vr-continuous${NC}"

# Create server script based on model choice
if [ "$MODEL" = "parakeet" ]; then
    echo "${YELLOW}→ Creating Parakeet server...${NC}"
    cat > ~/xln/ai/stt-server.py << 'EOFPYTHON'
#!/usr/bin/env python3
"""XLN Parakeet Server - Fast MLX STT"""
import os
from flask import Flask, request, jsonify
from parakeet_mlx import transcribe

app = Flask(__name__)

@app.route('/transcribe', methods=['POST'])
def transcribe_audio():
    if 'file' not in request.files:
        return jsonify({'error': 'No file provided'}), 400

    audio_file = request.files['file']
    temp_path = f"/tmp/stt_upload_{os.getpid()}.wav"
    audio_file.save(temp_path)

    try:
        result = transcribe(temp_path)
        os.remove(temp_path)
        return jsonify({
            'text': result['text'].strip(),
            'language': 'auto',
            'task': 'transcribe'
        })
    except Exception as e:
        if os.path.exists(temp_path):
            os.remove(temp_path)
        return jsonify({'error': str(e)}), 500

@app.route('/', methods=['GET'])
def health():
    return jsonify({'status': 'ok', 'model': 'parakeet-0.6b-v3'})

if __name__ == '__main__':
    print("Starting Parakeet server on http://0.0.0.0:5001")
    app.run(host='0.0.0.0', port=5001, debug=False, threaded=True)
EOFPYTHON
else
    # Whisper server (existing)
    cat > ~/xln/ai/stt-server.py << 'EOFPYTHON'
#!/usr/bin/env python3
"""XLN Whisper Server - SOTA Quality MLX STT"""
import os
import sys
from flask import Flask, request, jsonify
import mlx_whisper

app = Flask(__name__)

print("Loading Whisper model into memory...")
MODEL_PATH = "mlx-community/whisper-large-v3-mlx"
model = None

try:
    model = mlx_whisper.load_models.load_model(MODEL_PATH)
    print(f"✅ Model loaded: {MODEL_PATH}")
except Exception as e:
    print(f"❌ Failed to load model: {e}")
    sys.exit(1)

@app.route('/transcribe', methods=['POST'])
def transcribe():
    if 'file' not in request.files:
        return jsonify({'error': 'No file provided'}), 400

    audio_file = request.files['file']
    task = request.form.get('task', 'transcribe')
    language = request.form.get('language', None)

    temp_path = f"/tmp/whisper_upload_{os.getpid()}.wav"
    audio_file.save(temp_path)

    try:
        result = mlx_whisper.transcribe(
            temp_path,
            path_or_hf_repo=MODEL_PATH,
            task=task,
            language=language,
            verbose=False
        )

        text = result.get("text", "").strip()
        os.remove(temp_path)

        return jsonify({
            'text': text,
            'language': result.get('language', 'unknown'),
            'task': task
        })
    except Exception as e:
        if os.path.exists(temp_path):
            os.remove(temp_path)
        return jsonify({'error': str(e)}), 500

@app.route('/', methods=['GET'])
def health():
    return jsonify({'status': 'ok', 'model': MODEL_PATH})

if __name__ == '__main__':
    print("Starting Whisper server on http://0.0.0.0:5001")
    app.run(host='0.0.0.0', port=5001, debug=False, threaded=True)
EOFPYTHON
fi

chmod +x ~/xln/ai/stt-server.py
echo "${GREEN}✓ Created STT server${NC}"

# Symlink for compatibility
ln -sf ~/xln/ai/stt-server.py ~/xln/ai/whisper-server.py 2>/dev/null || true

# Create Hammerspoon config
echo "${YELLOW}→ Creating Hammerspoon config...${NC}"
mkdir -p ~/.hammerspoon

cat > ~/.hammerspoon/init.lua << 'EOFLUA'
-- XLN Voice Paste - Global hotkeys
-- Cmd+, = Auto-detect | Cmd+. = Translate to EN

local recording = false
local currentTask = nil

function startRecording(lang)
    if recording then return end
    recording = true

    hs.alert.show(lang == "translate-en" and "🌍→🇬🇧" or "🎤", 999)

    currentTask = hs.task.new(os.getenv("HOME") .. "/xln/ai/vr-continuous", function(exitCode, stdOut)
        hs.alert.closeAll()

        local ms = stdOut and tonumber(stdOut:match("%d+")) or 0

        if exitCode == 0 then
            hs.alert.show("✅ " .. ms .. "ms", 1)
        elseif exitCode == 2 then
            hs.alert.show("❌ Recording failed", 2)
        elseif exitCode == 3 then
            hs.alert.show("❌ Too quiet/short", 2)
        elseif exitCode == 4 then
            hs.alert.show("❌ Server down", 2)
        elseif exitCode == 8 then
            hs.alert.show("❌ Clipboard timeout", 2)
        else
            hs.alert.show("❌ Error " .. tostring(exitCode), 2)
        end

        recording = false
        currentTask = nil
    end, {lang})

    currentTask:start()
end

function stopRecording()
    if not recording or not currentTask then return end

    hs.alert.closeAll()
    hs.alert.show("⏹️", 1)

    currentTask:terminate()
    recording = false
end

-- Cmd+, = Auto
hs.hotkey.bind({"cmd"}, ",",
    function() startRecording("auto") end,
    function() stopRecording() end,
    function() startRecording("auto") end)

-- Cmd+. = Translate
hs.hotkey.bind({"cmd"}, ".",
    function() startRecording("translate-en") end,
    function() stopRecording() end,
    function() startRecording("translate-en") end)

-- Auto-start STT server with ffmpeg PATH
hs.task.new("/usr/bin/env", nil, function(exitCode, stdOut, stdErr)
    if exitCode ~= 0 then
        print("STT server failed to start: " .. tostring(stdErr))
    end
end, {"bash", "-c", "export PATH=/opt/homebrew/bin:$PATH && python3 " .. os.getenv("HOME") .. "/xln/ai/stt-server.py"}):start()
print("Started STT server")

hs.alert.show("🎤\n⌘, = Auto\n⌘. = →EN", 2)
print("Voice ready")
EOFLUA

echo "${GREEN}✓ Created Hammerspoon config${NC}"

# Final instructions
echo ""
echo "╔══════════════════════════════════════════════════════════════════╗"
echo "║                     Installation Complete!                       ║"
echo "╚══════════════════════════════════════════════════════════════════╝"
echo ""
echo "${GREEN}Next steps:${NC}"
echo ""
echo "1. Launch Hammerspoon:"
echo "   ${YELLOW}open -a Hammerspoon${NC}"
echo ""
echo "2. Grant permissions:"
echo "   - Accessibility: System Settings → Privacy & Security"
echo "   - Input Monitoring: System Settings → Privacy & Security"
echo ""
echo "3. Use voice transcription:"
echo "   ${GREEN}• Cmd+,${NC} - Hold, speak, release → pastes"
echo "   ${GREEN}• Cmd+.${NC} - Hold, speak, release → translates to English → pastes"
echo ""
echo "4. Model: ${YELLOW}$([ "$MODEL" = "parakeet" ] && echo "Parakeet 0.6B (fast)" || echo "Whisper large-v3 (quality)")${NC}"
echo ""
echo "5. Recordings: ${YELLOW}~/records/YYYY-MM-DD/${NC}"
echo "6. Debug logs: ${YELLOW}/tmp/vr-debug.log${NC}"
echo ""
echo "${GREEN}100% local. No cloud. Perfect privacy.${NC}"
echo ""
