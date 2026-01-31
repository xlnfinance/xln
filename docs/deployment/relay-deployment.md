# XLN Relay Server Deployment

## Overview

The relay server enables P2P communication between XLN runtime instances (browsers, CLIs, servers).

**Purpose:** Routes encrypted messages between peers for bilateral consensus coordination.

---

## Production Deployment (xln.finance)

### Option A: PM2 (Recommended)

```bash
# Install PM2 globally
npm install -g pm2

# Start relay as daemon
pm2 start runtime/networking/ws-server.ts --name xln-relay --interpreter bun -- --port 9000 --host 0.0.0.0

# Save PM2 config
pm2 save

# Auto-start on reboot
pm2 startup
```

**Monitor:**
```bash
pm2 logs xln-relay  # View logs
pm2 status          # Check status
pm2 restart xln-relay  # Restart
```

---

### Option B: Systemd Service

**Create `/etc/systemd/system/xln-relay.service`:**
```ini
[Unit]
Description=XLN WebSocket Relay Server
After=network.target

[Service]
Type=simple
User=xln
WorkingDirectory=/var/www/xln
ExecStart=/usr/local/bin/bun runtime/networking/ws-server.ts --port 9000 --host 0.0.0.0
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
```

**Enable and start:**
```bash
sudo systemctl enable xln-relay
sudo systemctl start xln-relay
sudo systemctl status xln-relay
```

---

### Option C: Nginx Reverse Proxy (WebSocket)

**Nginx config (`/etc/nginx/sites-available/xln.finance`):**
```nginx
# Relay endpoint
location /relay {
    proxy_pass http://localhost:9000;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "Upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_read_timeout 3600s;
    proxy_send_timeout 3600s;
}
```

**With SSL:**
```nginx
server {
    listen 443 ssl http2;
    server_name xln.finance;

    ssl_certificate /etc/letsencrypt/live/xln.finance/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/xln.finance/privkey.pem;

    # Relay WebSocket
    location /relay {
        proxy_pass http://localhost:9000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "Upgrade";
    }

    # Static files
    location / {
        root /var/www/xln/frontend/build;
        try_files $uri $uri/ /index.html;
    }
}
```

**Test WebSocket:**
```bash
curl -i -N \
  -H "Connection: Upgrade" \
  -H "Upgrade: websocket" \
  -H "Sec-WebSocket-Version: 13" \
  -H "Sec-WebSocket-Key: test" \
  https://xln.finance/relay
# Should return: HTTP/1.1 101 Switching Protocols
```

---

## Configuration

**Environment variables:**
```bash
RELAY_PORT=9000
RELAY_HOST=0.0.0.0
RELAY_SERVER_ID=xln-mainnet-relay
RELAY_MAX_QUEUE=1000
RELAY_REQUIRE_AUTH=true
```

**For xln.finance:**
```bash
# production.env
RELAY_PORT=9000
RELAY_HOST=127.0.0.1  # Only accessible via nginx proxy
RELAY_REQUIRE_AUTH=true
```

---

## Security

**P2P relay is intentionally "dumb":**
- Routes messages without validation
- All crypto verification happens at entity/account layer
- Even malicious relay can't forge transactions (needs validator keys)

**Anti-spam measures:**
- Max 1000 queued messages per runtime
- 5-minute TTL for undelivered messages
- Hello message signature verification

**For production:**
- Rate limiting (nginx: `limit_req_zone`)
- DDoS protection (Cloudflare or similar)
- Monitor: connections, message throughput, queue sizes

---

## Monitoring

**Health check:**
```bash
curl http://localhost:9000/health
# Expected: {"status":"ok","connections":N}
```

**Logs to watch:**
```bash
# PM2:
pm2 logs xln-relay | grep -E "WS.*connect|ERROR"

# Systemd:
journalctl -u xln-relay -f | grep -E "connect|ERROR"
```

**Metrics:**
- Active connections (should be < 10k for single relay)
- Messages/sec (expect < 100 in testnet, < 10k in mainnet)
- Queue depth (should be near 0, spike during network issues)

---

## Deployment Checklist

- [ ] Relay server running (PM2 or systemd)
- [ ] Port 9000 open (firewall)
- [ ] Nginx proxy configured (/relay endpoint)
- [ ] SSL certificate valid (Let's Encrypt)
- [ ] WebSocket upgrade working (test with curl)
- [ ] Frontend connects successfully (check browser console)
- [ ] Multi-user test (2 browsers see each other)

---

## Troubleshooting

**"Connection refused":**
- Check relay server running: `pm2 status` or `systemctl status xln-relay`
- Check port open: `netstat -tulpn | grep 9000`

**"SSL handshake failed":**
- Check nginx config: `nginx -t`
- Check SSL cert: `certbot certificates`

**"No peers visible":**
- Check browser console for P2P logs
- Verify relay URL in xlnStore.ts matches deployment
- Test relay health endpoint

---

## Quick Deploy Script

```bash
#!/bin/bash
# deploy-relay.sh

cd /var/www/xln
git pull
bun install
pm2 restart xln-relay || pm2 start runtime/networking/ws-server.ts --name xln-relay --interpreter bun -- --port 9000
pm2 save
echo "✅ Relay deployed"
```

**Usage:**
```bash
chmod +x deploy-relay.sh
./deploy-relay.sh
```
