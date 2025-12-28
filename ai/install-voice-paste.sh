#!/bin/bash
# XLN Voice Paste - Universal Installer
# 100% local voice transcription for macOS

set -e

echo "╔══════════════════════════════════════════════════════════════════╗"
echo "║         XLN Voice Paste - Local Voice Transcription             ║"
echo "╚══════════════════════════════════════════════════════════════════╝"
echo ""

# Colors
RED=$'\033[0;31m'
GREEN=$'\033[0;32m'
YELLOW=$'\033[1;33m'
CYAN=$'\033[0;36m'
NC=$'\033[0m'

CONFIG_FILE="$HOME/.xln-voice-config"

# ============================================================================
# SYSTEM CHECK
# ============================================================================

echo "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo "${CYAN}                      SYSTEM STATUS CHECK${NC}"
echo "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""

# Check Apple Silicon
ARCH=$(uname -m)
if [ "$ARCH" = "arm64" ]; then
    echo "${GREEN}✓${NC} Apple Silicon detected (${ARCH})"
else
    echo "${RED}✗${NC} Requires Apple Silicon (M1/M2/M3/M4), got: ${ARCH}"
    exit 1
fi

# Check RAM
RAM_GB=$(sysctl -n hw.memsize | awk '{print int($1/1024/1024/1024)}')
echo "${GREEN}✓${NC} RAM: ${RAM_GB}GB unified memory"

# Check dependencies
check_dep() {
    local name=$1
    local check=$2
    local var=$3
    if eval "$check" &>/dev/null; then
        echo "${GREEN}✓${NC} $name"
        eval "$var=true"
    else
        echo "${YELLOW}○${NC} $name not installed"
        eval "$var=false"
    fi
}

check_dep "Homebrew" "command -v brew" HAS_BREW
check_dep "sox (audio recording)" "command -v rec" HAS_SOX
check_dep "ffmpeg" "command -v ffmpeg" HAS_FFMPEG
check_dep "Hammerspoon" "[ -d /Applications/Hammerspoon.app ]" HAS_HAMMERSPOON
check_dep "Flask" "python3 -c 'import flask'" HAS_FLASK
check_dep "mlx-whisper" "python3 -c 'import mlx_whisper'" HAS_MLX_WHISPER

# Check STT server
if curl -sf http://localhost:5001/ > /dev/null 2>&1; then
    SERVER_INFO=$(curl -s http://localhost:5001/)
    echo "${GREEN}✓${NC} STT server running: $(echo $SERVER_INFO | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('model','?'))" 2>/dev/null)"
    STT_RUNNING=true
else
    echo "${YELLOW}○${NC} STT server not running"
    STT_RUNNING=false
fi

# Check config
if [ -f "$CONFIG_FILE" ]; then
    CURRENT_MODEL=$(grep "^model=" "$CONFIG_FILE" 2>/dev/null | cut -d= -f2)
    echo "${GREEN}✓${NC} Config: $CONFIG_FILE (model=$CURRENT_MODEL)"
else
    echo "${YELLOW}○${NC} Config not found"
fi

# Check Hammerspoon config
if [ -f ~/.hammerspoon/init.lua ] && grep -q "vr-continuous" ~/.hammerspoon/init.lua 2>/dev/null; then
    echo "${GREEN}✓${NC} Hammerspoon configured for voice paste"
    HS_CONFIGURED=true
else
    echo "${YELLOW}○${NC} Hammerspoon not configured"
    HS_CONFIGURED=false
fi

# Check cached models
echo ""
echo "Cached whisper models:"
FOUND_MODELS=0
for model in whisper-tiny whisper-medium-mlx whisper-large-v3-mlx; do
    if [ -d ~/.cache/huggingface/hub/models--mlx-community--${model} ]; then
        size=$(du -sh ~/.cache/huggingface/hub/models--mlx-community--${model} 2>/dev/null | cut -f1)
        echo "  ${GREEN}✓${NC} ${model} (${size})"
        FOUND_MODELS=$((FOUND_MODELS + 1))
    fi
done
[ $FOUND_MODELS -eq 0 ] && echo "  ${YELLOW}○${NC} None cached yet"

echo ""

# ============================================================================
# INSTALL MISSING DEPENDENCIES
# ============================================================================

echo "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo "${CYAN}                    INSTALLING DEPENDENCIES${NC}"
echo "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""

if [ "$HAS_BREW" = false ]; then
    echo "${YELLOW}→ Installing Homebrew...${NC}"
    /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
    eval "$(/opt/homebrew/bin/brew shellenv)"
fi

[ "$HAS_SOX" = false ] && echo "${YELLOW}→ Installing sox...${NC}" && brew install sox
[ "$HAS_FFMPEG" = false ] && echo "${YELLOW}→ Installing ffmpeg...${NC}" && brew install ffmpeg
[ "$HAS_HAMMERSPOON" = false ] && echo "${YELLOW}→ Installing Hammerspoon...${NC}" && brew install --cask hammerspoon
[ "$HAS_FLASK" = false ] && echo "${YELLOW}→ Installing Flask...${NC}" && pip3 install flask
[ "$HAS_MLX_WHISPER" = false ] && echo "${YELLOW}→ Installing mlx-whisper...${NC}" && pip3 install mlx-whisper

echo "${GREEN}✓ All dependencies installed${NC}"

# Create directories
mkdir -p ~/records
mkdir -p ~/xln/ai

# ============================================================================
# CONFIG FILE
# ============================================================================

echo ""
echo "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo "${CYAN}                         CONFIGURATION${NC}"
echo "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""

if [ ! -f "$CONFIG_FILE" ]; then
    echo "Choose model tier:"
    echo ""
    echo "  ${GREEN}1)${NC} ${YELLOW}tiny${NC}      -  75MB, fastest, basic quality"
    echo "  ${GREEN}2)${NC} ${YELLOW}medium${NC}    - 1.5GB, balanced"
    echo "  ${GREEN}3)${NC} ${YELLOW}large-v3${NC}  - 3.1GB, best quality (RECOMMENDED)"
    echo ""
    read -p "Model [3]: " MODEL_CHOICE
    MODEL_CHOICE=${MODEL_CHOICE:-3}

    case $MODEL_CHOICE in
        1) MODEL="tiny" ;;
        2) MODEL="medium" ;;
        3) MODEL="large-v3" ;;
        *) MODEL="large-v3" ;;
    esac

    cat > "$CONFIG_FILE" << EOF
# XLN Voice Paste Config
# Options: tiny, medium, large-v3
model=$MODEL
EOF
    echo "${GREEN}✓ Created config: $CONFIG_FILE${NC}"
else
    MODEL=$(grep "^model=" "$CONFIG_FILE" 2>/dev/null | cut -d= -f2)
    echo "${GREEN}✓ Using existing config: model=$MODEL${NC}"
    echo "  Edit $CONFIG_FILE to change model"
fi

# ============================================================================
# CREATE FILES IF MISSING
# ============================================================================

echo ""
echo "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo "${CYAN}                          SETUP FILES${NC}"
echo "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""

# Verify required files exist (source of truth is the actual files, not this installer)
MISSING_FILES=()
[ ! -f ~/xln/ai/stt-server.py ] && MISSING_FILES+=("stt-server.py")
[ ! -f ~/xln/ai/vr-continuous ] && MISSING_FILES+=("vr-continuous")

if [ ${#MISSING_FILES[@]} -gt 0 ]; then
    echo "${RED}✗ Missing required files: ${MISSING_FILES[*]}${NC}"
    echo "  These files should exist in ~/xln/ai/"
    echo "  Clone the xln repo or restore from backup."
    exit 1
fi

echo "${GREEN}✓ stt-server.py${NC}"
echo "${GREEN}✓ vr-continuous${NC}"
chmod +x ~/xln/ai/stt-server.py ~/xln/ai/vr-continuous

# Hammerspoon config (only file we create, since it lives outside repo)
if [ "$HS_CONFIGURED" = true ]; then
    echo "${GREEN}✓ Hammerspoon config exists${NC}"
else
    echo "${YELLOW}→ Creating Hammerspoon config...${NC}"
    mkdir -p ~/.hammerspoon
    cat > ~/.hammerspoon/init.lua << 'EOFLUA'
-- XLN Voice Paste
local recording, currentTask = false, nil

function startRecording(lang)
    if recording then return end
    recording = true
    hs.alert.show(lang == "translate-en" and "🌍→🇬🇧" or "🎤", 999)
    currentTask = hs.task.new(os.getenv("HOME") .. "/xln/ai/vr-continuous", function(code, out)
        hs.alert.closeAll()
        local ms = out and tonumber(out:match("%d+")) or 0
        if code == 0 then hs.alert.show("✅ " .. ms .. "ms", 1)
        elseif code == 4 then hs.alert.show("❌ Server down", 2)
        elseif code == 5 then hs.alert.show("⏳ Busy", 1)
        else hs.alert.show("❌ Error " .. code, 2) end
        recording, currentTask = false, nil
    end, {lang})
    currentTask:start()
end

function stopRecording()
    if not recording or not currentTask then return end
    hs.alert.closeAll(); hs.alert.show("⏹️", 1)
    currentTask:terminate(); recording = false
end

hs.hotkey.bind({"cmd"}, ",", function() startRecording("auto") end, function() stopRecording() end)
hs.hotkey.bind({"cmd"}, ".", function() startRecording("translate-en") end, function() stopRecording() end)

-- Auto-start server
hs.task.new("/usr/bin/pgrep", function(code)
    if code ~= 0 then
        hs.task.new("/usr/bin/env", nil, {"bash", "-c", "python3 ~/xln/ai/stt-server.py > /tmp/stt-server.log 2>&1"}):start()
    end
end, {"-f", "stt-server.py"}):start()

-- Kill server on Hammerspoon quit/reload
hs.shutdownCallback = function()
    os.execute("pkill -f stt-server.py")
end

hs.alert.show("🎤 ⌘, / ⌘.", 2)
EOFLUA
    echo "${GREEN}✓ Created Hammerspoon config${NC}"
fi

# Symlink
ln -sf ~/xln/ai/stt-server.py ~/xln/ai/whisper-server.py 2>/dev/null || true

# ============================================================================
# DONE
# ============================================================================

echo ""
echo "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo "${CYAN}                              DONE${NC}"
echo "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""
echo "${GREEN}Usage:${NC}"
echo "  ${YELLOW}⌘ ,${NC} (hold) - Record → Paste"
echo "  ${YELLOW}⌘ .${NC} (hold) - Record → Translate to English → Paste"
echo ""
echo "${GREEN}Change model:${NC}"
echo "  Edit ${YELLOW}~/.xln-voice-config${NC} then restart server:"
echo "  ${YELLOW}pkill -f stt-server.py && open -a Hammerspoon${NC}"
echo ""
echo "${GREEN}Files:${NC}"
echo "  ~/.xln-voice-config     - Config (model selection)"
echo "  ~/xln/ai/stt-server.py  - Server"
echo "  ~/xln/ai/vr-continuous  - Recording script"
echo "  ~/records/              - Audio archive"
echo ""
