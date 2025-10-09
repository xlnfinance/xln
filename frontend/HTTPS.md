# HTTPS Setup for Local Development

XLN requires HTTPS for secure contexts (WebAuthn, Crypto API, VR features).

## ⚠️ **CRITICAL: Dev-Only Configuration**

**This HTTPS setup ONLY affects `bun run dev` (local development).**

### **Production Deployment (nginx):**

```
✅ `bun run build` → Generates static files to frontend/build/
✅ nginx serves static HTML/CSS/JS with its own HTTPS config
✅ vite.config.ts is completely ignored in production
✅ Your nginx certificates are used (not these .pem files)
```

**TL;DR:** Your nginx deployment won't break - this config is dev-only!

See `nginx-example.conf` for production HTTPS setup.

---

## Using Existing Certs

Your `vite.config.ts` will automatically use:
1. `frontend/localhost+2.pem` (if exists)
2. Fallback to `../192.168.1.23+2.pem` ✅ **Currently using this**

## Generate New Localhost Certs

```bash
# Install mkcert (one-time)
brew install mkcert              # macOS
# or: https://github.com/FiloSottile/mkcert

# Initialize CA (one-time)
mkcert -install

# Generate certs (from frontend/ directory)
cd frontend
./generate-certs.sh

# Or manually:
mkcert localhost 127.0.0.1 ::1
```

## Access Your App

**HTTP:**  `http://localhost:8080` (no certs needed)
**HTTPS:** `https://localhost:8080` (with certs)

## Troubleshooting

**Browser shows "Not Secure"?**
- Run `mkcert -install` to trust the local CA
- Chrome: Type `thisisunsafe` on the warning page

**HMR not working?**
- Vite auto-switches to WSS protocol when HTTPS is enabled
- Check browser console for WebSocket connection errors

**Using LAN IP?**
- Generate certs for your IP: `mkcert localhost 192.168.1.23`
- Update `vite.config.ts` certPath to match

---

**Security Note:** These certs are for **development only**. Production uses nginx with proper certificates (see `nginx-example.conf`).
