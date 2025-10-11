# Oculus Quest 3 / Network Device Setup

## Problem

By default, Hardhat and the app bind to `localhost` (127.0.0.1) which is not accessible from other devices on your network (Oculus Quest, phones, etc).

## Solution

### 1. Start Hardhat Node on Network Interface

**Option A: Use package.json script (updated)**
```bash
bun run env:run
# Now binds to 0.0.0.0:8545 (accessible from network)
```

**Option B: Manual start**
```bash
cd contracts
npx hardhat node --hostname 0.0.0.0
```

### 2. Update jurisdictions.json with your local IP

Find your local IP:
```bash
ifconfig | grep "inet " | grep -v 127.0.0.1
# Example output: inet 192.168.0.197
```

Edit `jurisdictions.json`:
```json
{
  "jurisdictions": {
    "ethereum": {
      "rpc": "http://192.168.0.197:8545",  // ← Use your actual IP
      ...
    }
  }
}
```

### 3. Access from Oculus

In Quest 3 browser, navigate to:
```
http://192.168.0.197:8080  // Your IP + Vite port
```

## WebXR / VR Mode

### HTTPS Requirement

WebXR requires HTTPS in production. For local dev:

**Option A: Self-signed certificate**
```bash
# Generate cert
openssl req -x509 -newkey rsa:4096 -keyout key.pem -out cert.pem -days 365 -nodes

# Update vite.config.ts
server: {
  https: {
    key: fs.readFileSync('key.pem'),
    cert: fs.readFileSync('cert.pem')
  }
}
```

**Option B: ngrok tunnel (RECOMMENDED for Oculus)**
```bash
# Start ngrok
ngrok http 8080

# Use the https URL in Oculus browser
# Example: https://abc-def-ghi.ngrok-free.app
```

**Important:** Vite config already set to `allowedHosts: ['all']` to accept ngrok tunnels.

### VR Button Detection

The VR button appears only when:
1. ✅ Page served over HTTPS (or localhost)
2. ✅ `navigator.xr.isSessionSupported('immersive-vr')` returns true
3. ✅ Oculus browser (check console for WebXR Detection log)

Check browser console on Quest for:
```
🥽 WebXR Detection: {
  hasNavigatorXR: true,
  isSessionSupported: true,  // ← Must be true
  isSecureContext: true,     // ← Must be true for production
  ...
}
```

## Quick Test Commands

```bash
# Terminal 1: Start Hardhat (network accessible)
bun run env:run

# Terminal 2: Deploy contracts
./deploy-contracts.sh

# Terminal 3: Start Vite (already binds to 0.0.0.0)
bun run dev

# From Oculus:
# http://192.168.0.197:8080  (your IP)
```

## Network Configuration Summary

| Service | Default | Network Accessible | Port |
|---------|---------|-------------------|------|
| Vite | ✅ 0.0.0.0 | Yes | 8080 |
| Hardhat | ❌ 127.0.0.1 → ✅ 0.0.0.0 | Yes (after fix) | 8545 |

## Troubleshooting

**"Failed to get next entity number"**
- Hardhat not accessible from network
- Check: `curl http://YOUR_IP:8545 -X POST -H "Content-Type: application/json" --data '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}'`
- Should return: `{"jsonrpc":"2.0","id":1,"result":"0x..."}`

**VR button not showing**
- Check browser console for WebXR logs
- Verify `isSecureContext: true` (needs HTTPS)
- Try accessing via ngrok HTTPS tunnel

**Connection refused from Oculus**
- Firewall blocking port 8080 or 8545
- macOS: System Settings → Network → Firewall → Allow incoming
