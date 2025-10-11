# Verify Dev Server is Running

Before running E2E tests, verify the dev server is up:

## Quick Check

```bash
# Should return 200 OK (or redirect)
curl -k https://localhost:8080

# Should show "READY" in output
curl -k https://localhost:8080 | grep -i "xln\|ready\|runtime"
```

## If Server Not Running

You'll see:
```
curl: (7) Failed to connect to localhost port 8080: Connection refused
```

**Fix:**
```bash
bun run dev
```

## Verify All Services

After `bun run dev`, check:

### 1. HTTPS Frontend
```bash
curl -k https://localhost:8080
# Should return HTML
```

### 2. HTTP Frontend (fallback)
```bash
curl http://localhost:8080
# Should return HTML or redirect to HTTPS
```

### 3. Anvil Blockchain
```bash
curl -X POST http://localhost:8545 \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}'

# Should return: {"jsonrpc":"2.0","id":1,"result":"0x..."}
```

### 4. Runtime.js Built
```bash
ls -lh frontend/static/runtime.js
# Should exist and be >100KB
```

## Common Issues

### Port 8080 Already in Use
```bash
lsof -ti:8080 | xargs kill -9
bun run dev
```

### Port 8545 Already in Use (Anvil)
```bash
lsof -ti:8545 | xargs kill -9
bun run dev
```

### HTTPS Certificate Issues
- XLN uses self-signed certs in `certs/`
- Valid until 2028
- Safe for localhost development
- Playwright/Chrome may need `-k` or `--ignore-certificate-errors`

## Ready to Test?

Once `bun run dev` shows:
```
✅ ✅ ✅ DEVELOPMENT ENVIRONMENT READY ✅ ✅ ✅
```

You can run E2E tests:
```
Run E2E smoke test
```
