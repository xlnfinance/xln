# XLN Deployment Lessons Learned

## 🎯 Key Lessons from Vultr Deployment

### 1. **Bundle Dependencies for Browser** ⚠️ CRITICAL
**Problem:** `bun build --target browser` doesn't bundle dependencies by default
**Solution:** Always use `--bundle` flag

```bash
# ❌ Wrong - leaves imports external
bun build src/server.ts --target browser --outfile frontend/static/server.js

# ✅ Correct - bundles all dependencies  
bun build src/server.ts --target browser --outfile frontend/static/server.js --bundle
```

**Why:** Browser can't resolve `import { Level } from 'level'` - needs to be bundled

### 2. **File Permissions with Nginx** ⚠️ CRITICAL
**Problem:** Nginx can't read files in `/root/` directory
**Solution:** Use proxy-only Nginx config, don't serve static files from `/root/`

```nginx
# ✅ Correct - proxy everything to Bun server
location / {
    proxy_pass http://localhost:8080;
}

# ❌ Wrong - can't read /root/xln/frontend/build/
location / {
    root /root/xln/frontend/build;
}
```

### 3. **Svelte Base Path Configuration** ⚠️ CRITICAL
**Problem:** Svelte builds with `/xln` base path for GitHub Pages
**Solution:** Set empty base path for server deployment

```javascript
// frontend/svelte.config.js
paths: {
    base: '' // ✅ Empty for server deployment
    // base: '/xln' // ❌ Only for GitHub Pages
}
```

### 4. **Process Management - Simple is Better**
**Problem:** systemd service was complex and problematic
**Solution:** Use simple `nohup` background process

```bash
# ✅ Simple and reliable
nohup bun run serve.ts > logs/xln.log 2>&1 &

# ❌ Complex systemd service had issues
systemctl start xln
```

### 5. **Server.js Must Be Consistent**
**Problem:** Different server.js files in different locations
**Solution:** Always copy bundled server.js to both locations

```bash
# Build bundled version
bun build src/server.ts --target browser --outfile frontend/static/server.js --bundle

# Copy to build directory
cp frontend/static/server.js frontend/build/server.js
```

### 6. **Never Edit Code on Server** ⚠️ CRITICAL
**Problem:** Direct server edits break git workflow
**Solution:** Always commit → push → pull → deploy

```bash
# ✅ Correct workflow
git add . && git commit -m "fix" && git push origin main
ssh server "cd /root/xln && git pull && ./deploy.sh"

# ❌ Never edit directly on server
ssh server "nano /root/xln/serve.ts"
```

### 7. **Test Health Check in Deploy Script**
**Solution:** Always verify server is responding after deployment

```bash
# Wait for server to start
sleep 3

# Test health check
if curl -s http://localhost:8080/healthz > /dev/null; then
    echo "✅ Server is responding!"
else
    echo "⚠️  Server might still be starting..."
    tail -5 logs/xln.log
fi
```

## 🚀 Updated Deployment Checklist

### Fresh Server Setup:
1. ✅ Use `setup-server-bun.sh` (pure Bun, no Node.js/PM2)
2. ✅ Configure Nginx as pure proxy (no static file serving)
3. ✅ Set up deployment script with bundling

### Every Deployment:
1. ✅ Commit changes locally first
2. ✅ Push to GitHub
3. ✅ Pull on server  
4. ✅ Build server.js with `--bundle` flag
5. ✅ Copy bundled server.js to both locations
6. ✅ Build frontend
7. ✅ Restart server with `nohup`
8. ✅ Test health check

### Debugging:
1. ✅ Check `tail -f logs/xln.log` for server errors
2. ✅ Check browser console for frontend errors
3. ✅ Verify `ps aux | grep bun` shows server running
4. ✅ Test `curl http://localhost:8080/healthz`

## 🎊 What Works Perfectly:

- ✅ **Pure Bun** - No Node.js needed, faster and simpler
- ✅ **Level DB** - Works perfectly in browser as IndexedDB wrapper
- ✅ **Svelte Frontend** - Fast and reactive
- ✅ **Nginx Proxy** - Simple reverse proxy setup
- ✅ **Git Workflow** - Commit → Push → Pull → Deploy

## 🔧 Architecture That Works:

```
Browser → Nginx (port 80) → Bun Server (port 8080)
                                ↓
                         serve.ts serves:
                         - frontend/build/ (Svelte app)
                         - /server.js (bundled XLN code)
```

The key insight: **Keep it simple, bundle dependencies, use git workflow!**
