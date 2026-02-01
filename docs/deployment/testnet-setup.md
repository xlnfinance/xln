# XLN Testnet Deployment

## Production Server Setup (xln.finance)

### Prerequisites

```bash
# Install Foundry (if not already installed)
curl -L https://foundry.paradigm.xyz | bash
foundryup

# Verify installation
anvil --version
```

### 1. Nginx RPC Proxy

Add to `/etc/nginx/sites-available/xln.finance`:

```nginx
# Anvil RPC proxy - allows HTTPS access to local anvil
location /rpc {
    proxy_pass http://localhost:8545;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;

    # CORS headers for browser access
    add_header Access-Control-Allow-Origin *;
    add_header Access-Control-Allow-Methods "GET, POST, OPTIONS";
    add_header Access-Control-Allow-Headers "Content-Type";

    # Handle preflight
    if ($request_method = OPTIONS) {
        return 204;
    }
}
```

Test and reload:
```bash
nginx -t
systemctl reload nginx
```

### 2. Start Anvil with PM2

```bash
cd /root/xln

# Create data/logs directories
mkdir -p data logs

# Start anvil via PM2
pm2 start scripts/start-anvil.sh --name xln-anvil --interpreter bash

# Save PM2 config
pm2 save

# Enable PM2 startup on reboot
pm2 startup
```

### 3. Verify RPC Access

```bash
# Local access
curl http://localhost:8545 -X POST -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}'

# Public access (via nginx)
curl https://xln.finance/rpc -X POST -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}'
```

Expected response:
```json
{"jsonrpc":"2.0","id":1,"result":"0x0"}
```

### 4. Firewall (Optional Direct Access)

```bash
# Allow direct :8545 access if needed
ufw allow 8545/tcp
```

### 5. Manual State Reset

```bash
# Stop anvil
pm2 stop xln-anvil

# Delete state file
rm /root/xln/data/anvil-state.json

# Restart anvil (fresh blockchain)
pm2 restart xln-anvil
```

### 6. Logs & Monitoring

```bash
# View anvil logs
pm2 logs xln-anvil

# Check status
pm2 status

# Check disk usage (state file can grow)
du -h /root/xln/data/anvil-state.json
```

## Next Steps

After anvil is running, deploy the hub daemon:
- See `runtime/prod-hub.ts`
- PM2 service: `pm2 start runtime/prod-hub.ts --name xln-hub --interpreter bun`
