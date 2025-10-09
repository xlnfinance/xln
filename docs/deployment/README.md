# XLN Deployment Guide

Complete guide for deploying XLN locally and to production.

---

## Local Development Deployment

### Architecture

```
┌─────────────────┐    ┌──────────────────┐    ┌─────────────────┐
│  Deploy Script  │ ─► │  Config Files    │ ─► │  Browser/Server │
└─────────────────┘    └──────────────────┘    └─────────────────┘
                             │
                             │
                    jurisdictions.json
                    (Unified Config)
```

### Network Configuration

**Three Parallel Local Networks:**
- **Ethereum** (port 8545) - Primary network
- **Polygon** (port 8546) - Secondary network
- **Arbitrum** (port 8547) - Tertiary network

Each network gets individual EntityProvider + Depository contracts with addresses automatically extracted and saved.

### Quick Commands

#### Complete Reset
```bash
./reset-networks.sh
```
- Stops all networks
- Cleans old data
- Starts fresh networks
- Deploys contracts to all 3 networks
- Generates jurisdictions.json config

#### Individual Operations
```bash
./start-networks.sh      # Start blockchain networks
./stop-networks.sh       # Stop all networks
./deploy-contracts.sh    # Deploy to running networks
./dev.sh                 # Development setup check
```

### Development Workflow

#### Starting Development
```bash
./dev.sh                 # Check and setup everything
bun run src/server.ts    # Start the server
open frontend/index.html # Open in browser
```

#### Fresh Deployment
```bash
./reset-networks.sh      # Complete reset
# Browser automatically refreshes with new addresses
```

#### Contract-Only Redeploy
```bash
./deploy-contracts.sh    # Keep networks, redeploy contracts
# Browser detects change and refreshes in ~5 seconds
```

### Synchronization Flow

1. **Deployment**: `./deploy-contracts.sh` runs
2. **Generation**: Creates jurisdictions.json with fresh addresses
3. **Detection**: Browser polls for config changes every 5s
4. **Refresh**: Automatic browser reload when new deployment detected
5. **Loading**: Fresh page loads with new contract addresses

### Config File Structure

```json
{
  "version": "1.0.0",
  "lastUpdated": "2024-01-15T10:30:00Z",
  "jurisdictions": {
    "ethereum": {
      "name": "Ethereum",
      "chainId": 1337,
      "rpc": "http://localhost:8545",
      "contracts": {
        "entityProvider": "0xa513E6E4b8f2a923D98304ec87F64353C4D5C853",
        "depository": "0xb513E6E4b8f2a923D98304ec87F64353C4D5C854"
      },
      "explorer": "http://localhost:8545",
      "currency": "ETH",
      "status": "active"
    }
  }
}
```

### Troubleshooting Local Development

#### Networks Not Starting
1. Kill existing processes: `./stop-networks.sh`
2. Check ports 8545-8547 are free
3. Start fresh: `./start-networks.sh`

#### Wrong Contract Addresses
1. Check jurisdictions.json was generated
2. Run `./deploy-contracts.sh` again
3. Browser should auto-refresh

---

## Production Deployment (Vultr)

### Server Requirements

- **OS:** Ubuntu 22.04 LTS
- **Plan:** Regular Performance (2GB RAM minimum)
- **Location:** Choose closest datacenter
- **SSH Key:** Add your public SSH key

### Quick Deploy

```bash
# SSH into your server
ssh root@YOUR_SERVER_IP

# Download and run deployment script
curl -fsSL https://raw.githubusercontent.com/xlnfinance/xln/main/deploy-vultr.sh | bash
```

### Access
- **Frontend:** `http://YOUR_SERVER_IP`
- **API:** `http://YOUR_SERVER_IP/api/`

### Manual Setup

#### 1. System Setup
```bash
# Update system
sudo apt update && sudo apt upgrade -y

# Install Node.js 18
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt-get install -y nodejs

# Install Bun
curl -fsSL https://bun.sh/install | bash
export PATH="$HOME/.bun/bin:$PATH"

# Install tools
sudo apt install -y git nginx
```

#### 2. Clone and Build
```bash
# Clone repository
git clone https://github.com/xlnfinance/xln.git
cd xln

# Install dependencies
bun install

# Build frontend (IMPORTANT: Set base path for server deployment)
cd frontend
# Edit svelte.config.js: paths.base = '' (not '/xln')
bun install
bun run build
cd ..

# Build server for browser (CRITICAL)
bun build src/server.ts --target browser --outfile frontend/static/server.js --bundle \
  --external http --external https --external zlib \
  --external fs --external path --external crypto \
  --external stream --external buffer --external url \
  --external net --external tls --external os --external util
```

#### 3. Run with nohup (Simple Process Management)
```bash
# Start server in background
nohup bun run src/server.ts > xln.log 2>&1 &

# Check it's running
ps aux | grep bun
tail -f xln.log

# Stop server
pkill -f "bun run src/server.ts"
```

#### 4. Configure Nginx (Proxy Mode)
```bash
# Create Nginx config
sudo tee /etc/nginx/sites-available/xln << 'EOF'
server {
    listen 80;
    server_name _;

    # Proxy everything to Bun server
    location / {
        proxy_pass http://localhost:8080;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }
}
EOF

# Enable site
sudo ln -sf /etc/nginx/sites-available/xln /etc/nginx/sites-enabled/
sudo rm -f /etc/nginx/sites-enabled/default
sudo systemctl restart nginx
```

### Management Commands

```bash
# View logs
tail -f ~/xln/xln.log

# Restart application
pkill -f "bun run src/server.ts"
cd ~/xln && nohup bun run src/server.ts > xln.log 2>&1 &

# Update application
cd ~/xln
git pull origin main
bun install
cd frontend && bun run build && cd ..
# Rebuild server.js for browser
bun build src/server.ts --target browser --outfile frontend/static/server.js --bundle \
  --external http --external https --external zlib \
  --external fs --external path --external crypto \
  --external stream --external buffer --external url \
  --external net --external tls --external os --external util
# Restart
pkill -f "bun run src/server.ts"
nohup bun run src/server.ts > xln.log 2>&1 &
```

### Security

#### Firewall Setup
```bash
# Install UFW
sudo apt install ufw

# Allow SSH, HTTP, HTTPS
sudo ufw allow ssh
sudo ufw allow 80
sudo ufw allow 443

# Enable firewall
sudo ufw --force enable
```

#### SSL Certificate (Optional)
```bash
# Install Certbot
sudo apt install certbot python3-certbot-nginx

# Get SSL certificate
sudo certbot --nginx -d your-domain.com

# Auto-renewal
sudo crontab -e
# Add: 0 12 * * * /usr/bin/certbot renew --quiet
```

### Monitoring

```bash
# Check if server is running
ps aux | grep bun

# Check port 8080
lsof -i :8080

# View logs
tail -f ~/xln/xln.log

# Check Nginx status
sudo systemctl status nginx

# Server resources
htop
df -h
free -h
```

---

## Critical Deployment Lessons

### 1. Browser Build Configuration ⚠️ CRITICAL

**Problem:** `bun build --target browser` doesn't bundle dependencies by default
**Solution:** Always use `--bundle` flag

```bash
# ❌ Wrong - leaves imports external
bun build src/server.ts --target browser --outfile frontend/static/server.js

# ✅ Correct - bundles all dependencies
bun build src/server.ts --target browser --outfile frontend/static/server.js --bundle
```

**Why:** Browser can't resolve `import { Level } from 'level'` - needs to be bundled inline.

**ALWAYS use ALL external flags:**
```bash
bun build src/server.ts --target browser --outfile frontend/static/server.js --bundle \
  --external http --external https --external zlib \
  --external fs --external path --external crypto \
  --external stream --external buffer --external url \
  --external net --external tls --external os --external util
```

### 2. File Permissions with Nginx ⚠️ CRITICAL

**Problem:** Nginx can't read files in `/root/` directory
**Solution:** Use proxy-only Nginx config

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

### 3. Svelte Base Path Configuration ⚠️ CRITICAL

**Problem:** Svelte builds with `/xln` base path for GitHub Pages
**Solution:** Set empty base path for server deployment

```javascript
// frontend/svelte.config.js
paths: {
    base: '' // ✅ Empty for server deployment
    // base: '/xln' // ❌ Only for GitHub Pages
}
```

### 4. Process Management - Simple is Better

**Problem:** systemd service was complex and problematic
**Solution:** Use simple `nohup` background process

```bash
# Simple and reliable
nohup bun run src/server.ts > xln.log 2>&1 &

# To stop
pkill -f "bun run src/server.ts"
```

### 5. Build Sequence Matters

**Correct build order:**
1. `bun install` (root dependencies)
2. `cd frontend && bun install` (frontend dependencies)
3. `bun run build` (frontend build)
4. Build server.js with `--target browser --bundle` and ALL external flags
5. Start server

### 6. Debugging Checklist

When deployment fails:
1. ✓ Is `--target browser` used?
2. ✓ Is `--bundle` flag present?
3. ✓ Are ALL `--external` flags present?
4. ✓ Is Svelte base path empty?
5. ✓ Is Nginx in proxy mode (not static file serving)?
6. ✓ Can browser access localhost:8080 directly?
7. ✓ Check browser console for module resolution errors

---

## Benefits

### Local Development
- ✅ Single command: `./reset-networks.sh`
- ✅ No manual address copying
- ✅ No hardcoded addresses
- ✅ Automatic browser sync
- ✅ Three parallel jurisdictions for testing

### Production
- ✅ Simple nohup process management
- ✅ Nginx reverse proxy
- ✅ Easy updates with git pull
- ✅ Standard Linux tools
- ✅ SSL support via Certbot

### Universal
- ✅ Bun runtime everywhere
- ✅ Browser-compatible server.js
- ✅ Consistent build process
- ✅ Minimal dependencies
