# Why HTTP Doesn't Work (By Design)

## TL;DR

**XLN dev server is HTTPS-only.** http://localhost:8080 will always fail with "Empty reply from server".

## Why?

When Vite detects HTTPS certificates (in `/certs` or `/frontend`), it:

1. ✅ Starts HTTPS server on port 8080
2. ❌ Does NOT start HTTP server
3. ❌ Does NOT redirect HTTP → HTTPS

This is **correct behavior** for security.

## Expected Behavior

| URL | Result |
|-----|--------|
| `http://localhost:8080` | ❌ Connection refused / Empty reply |
| `https://localhost:8080` | ✅ XLN loads correctly |

## Why HTTPS-Only?

**Modern web APIs require HTTPS:**
- WebXR (VR mode) - HTTPS only
- Service Workers - HTTPS only
- Web Crypto API - HTTPS only
- Secure contexts - HTTPS only

**Security best practices:**
- No mixed content (HTTPS page loading HTTP resources)
- No credential leakage over unencrypted connections
- Certificate validation from day 1

**Development convenience:**
- Same security model as production
- Test HTTPS issues early
- No HTTP→HTTPS redirect complexity

## Certificate Details

XLN uses mkcert-generated self-signed certificates:

```bash
# Location
frontend/localhost+2.pem
frontend/localhost+2-key.pem

# Valid for
localhost
127.0.0.1
::1

# Valid until
2028
```

## Browser Certificate Warnings

**First time accessing https://localhost:8080:**

Chrome/Edge will show: "Your connection is not private"

**Fix:**
1. Click "Advanced"
2. Click "Proceed to localhost (unsafe)"

This is safe for localhost development.

**Playwright/Automated Tests:**
- Use `-k` flag: `curl -k https://localhost:8080`
- Playwright ignores self-signed cert warnings by default

## Want HTTP Support?

If you absolutely need HTTP for testing:

### Option 1: Disable HTTPS (not recommended)

```bash
# Temporarily rename certs
mv frontend/localhost+2.pem frontend/localhost+2.pem.bak
mv frontend/localhost+2-key.pem frontend/localhost+2-key.pem.bak

# Restart dev server
bun run dev
# Now serves HTTP-only on http://localhost:8080
```

**Downside:** Breaks WebXR, Service Workers, etc.

### Option 2: Reverse Proxy (overkill)

Run nginx to redirect HTTP→HTTPS. Not worth it for dev.

### Option 3: Just Use HTTPS (recommended)

Accept that modern web development is HTTPS-only. Update bookmarks to use `https://localhost:8080`.

## Recommendation

**Keep HTTPS-only.** It's the correct configuration for XLN's feature set.

Update all documentation, bookmarks, and tests to use:
```
https://localhost:8080
```

Never use:
```
http://localhost:8080  ❌
```

## Vite Configuration

Current setup in `frontend/vite.config.ts`:

```typescript
server: {
  host: '0.0.0.0',
  port: 8080,
  ...(hasCerts && {
    https: {
      key: fs.readFileSync(keyPath),
      cert: fs.readFileSync(certPath),
    }
  }),
  hmr: {
    protocol: 'wss',  // WebSocket Secure for HMR
    host: 'localhost',
    port: 8080,
  }
}
```

**When certs exist:** HTTPS only (current behavior)
**When certs missing:** HTTP fallback (for environments without mkcert)

This is the correct configuration.
