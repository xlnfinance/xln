# Remote Voice Paste - Use STT from Any Device

## Setup Tailscale (encrypted VPN)

### On Mac Studio (server):

```bash
# Install Tailscale
brew install tailscale

# Start Tailscale
sudo tailscale up

# Get your Tailscale IP
tailscale ip -4
# Example output: 100.64.1.5
```

### Expose STT Server:

Server already listens on `0.0.0.0:5001` → accessible via Tailscale

**Test from another device:**
```bash
curl http://100.64.1.5:5001/
# Should return: {"status":"ok","model":"..."}
```

---

## Use from Another Mac

### Install client only (no server):

```bash
# Install dependencies
brew install sox hammerspoon tailscale

# Start Tailscale
sudo tailscale up

# Create vr-continuous (points to remote server)
cat > ~/vr-continuous << 'EOF'
#!/bin/bash
export PATH="/opt/homebrew/bin:$PATH"
export LANG=en_US.UTF-8

# CHANGE THIS to your Mac Studio Tailscale IP
SERVER_IP="100.64.1.5"

LANG_ARG="${1:-auto}"
AUDIO=/tmp/$(date +%H-%M-%S).wav

# Record
rec "$AUDIO" rate 16k channels 1 2>/dev/null &
REC_PID=$!
trap "kill -INT $REC_PID 2>/dev/null" TERM
wait $REC_PID 2>/dev/null
sleep 0.3

[ ! -s "$AUDIO" ] && exit 2

# Transcribe via remote server
START=$(python3 -c "import time; print(int(time.time()*1000))")
RES=$(curl -sf http://$SERVER_IP:5001/transcribe \
  -F "file=@$AUDIO" \
  -F "task=$([ "$LANG_ARG" = "translate-en" ] && echo translate || echo transcribe)" 2>&1)
TEXT=$(echo "$RES" | python3 -c "import sys,json; print(json.load(sys.stdin).get('text',''))" 2>/dev/null)
MS=$(( $(python3 -c "import time; print(int(time.time()*1000))") - START ))

rm "$AUDIO"
[ -z "$TEXT" ] && exit 3

# Paste
printf "%s" "$TEXT" | pbcopy
for i in {1..15}; do [ "$(pbpaste)" = "$TEXT" ] && break; sleep 0.1; done
sleep 0.15
osascript -e 'tell application "System Events" to keystroke "v" using command down' 2>/dev/null

echo "$MS"
EOF

chmod +x ~/vr-continuous
```

### Setup Hammerspoon:

Same config as Mac Studio, but use `~/vr-continuous` instead of `~/xln/ai/vr-continuous`

---

## Use from iPhone

### Option 1: Shortcuts App (Recommended)

**Create Shortcut:**

1. Open Shortcuts app
2. New Shortcut → "Voice Paste"
3. Add actions:
   - **Dictation** → Stop listening: "After pause"
   - **Get audio from input** → Store in variable "Audio"
   - **Get Contents of URL**:
     - URL: `http://100.64.1.5:5001/transcribe` (your Tailscale IP)
     - Method: `POST`
     - Headers: `Content-Type: multipart/form-data`
     - Request Body: Form → file: Audio, task: "transcribe"
   - **Get Dictionary from Input**
   - **Get Value for Key** → key: "text"
   - **Copy to Clipboard**
   - **Show Notification** → "✅ Pasted"

4. Add to Home Screen or Back Tap

**Security:** Tailscale encrypts all traffic (WireGuard)

### Option 2: SSH Tunnel

```bash
# On Mac Studio
brew install openssh-server

# On iPhone (using Blink Shell or Termius)
ssh -L 5001:localhost:5001 you@tailscale-ip
# Then use localhost:5001 from iPhone apps
```

---

## Performance

- **Local:** ~500-700ms (Whisper) or ~15ms (Parakeet)
- **Remote (same network):** +10-50ms
- **Remote (Tailscale):** +20-100ms (depends on internet)

## Security

✅ Tailscale uses WireGuard (military-grade encryption)
✅ No data leaves your devices (peer-to-peer)
✅ Better than cloud APIs
✅ Works offline (if on same local network)

---

## Troubleshooting

**Server not reachable:**
```bash
# On server Mac
tailscale status
# Should show "connected"

# Check firewall
sudo /usr/libexec/ApplicationFirewall/socketfilterfw --getglobalstate
# If blocking, allow Python
```

**Slow transcription:**
- Use Parakeet (60x faster)
- Check network: `ping tailscale-ip`
- Use local network instead of internet routing
