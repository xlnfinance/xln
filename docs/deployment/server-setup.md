# XLN Production Server Setup

## Nginx Configuration

Location: `/etc/nginx/sites-enabled/xln`

This is the ACTUAL production nginx config used on xln.finance server.

```nginx
# HTTP - serve /c and /c.txt directly (LLMs don't follow redirects), redirect everything else
server {
    listen 80;
    server_name xln.finance app.xln.finance;

    location /.well-known/acme-challenge/ {
        root /var/www/html;
    }

    # /c - Plain text display (for LLMs that don't follow HTTPS redirects)
    location = /c {
        alias /root/xln/frontend/build/c.txt;
        add_header Access-Control-Allow-Origin "*" always;
        add_header Access-Control-Allow-Methods "GET, HEAD, OPTIONS" always;
        add_header Content-Type "text/plain; charset=utf-8" always;
        add_header Cache-Control "no-store, no-cache, must-revalidate" always;
    }

    # /c.txt - Force download
    location = /c.txt {
        alias /root/xln/frontend/build/c.txt;
        add_header Access-Control-Allow-Origin "*" always;
        add_header Access-Control-Allow-Methods "GET, HEAD, OPTIONS" always;
        add_header Content-Type "text/plain; charset=utf-8" always;
        add_header Content-Disposition "attachment; filename=xln-context.txt" always;
        add_header Cache-Control "no-store, no-cache, must-revalidate" always;
    }

    location / {
        return 301 https://$server_name$request_uri;
    }
}

# HTTPS - Both root and app subdomain serve same content
server {
    listen 443 ssl http2;
    server_name xln.finance app.xln.finance;

    # Wildcard SSL certificate
    ssl_certificate /etc/letsencrypt/live/xln.finance/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/xln.finance/privkey.pem;

    # SSL configuration
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers HIGH:!aNULL:!MD5;
    ssl_prefer_server_ciphers on;

    # Security headers
    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
    add_header X-Content-Type-Options "nosniff" always;

    # /c - Plain text display (LLMs, curl, quick reads, no download prompt)
    location = /c {
        alias /root/xln/frontend/build/c.txt;
        add_header Access-Control-Allow-Origin "*" always;
        add_header Access-Control-Allow-Methods "GET, HEAD, OPTIONS" always;
        add_header Access-Control-Allow-Headers "*" always;
        add_header Content-Type "text/plain; charset=utf-8" always;
        add_header Cache-Control "no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0" always;
        expires off;
    }

    # /c.txt - Force download with clean filename
    location = /c.txt {
        alias /root/xln/frontend/build/c.txt;
        add_header Access-Control-Allow-Origin "*" always;
        add_header Access-Control-Allow-Methods "GET, HEAD, OPTIONS" always;
        add_header Access-Control-Allow-Headers "*" always;
        add_header Content-Type "text/plain; charset=utf-8" always;
        add_header Content-Disposition "attachment; filename=xln-context.txt" always;
        add_header Cache-Control "no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0" always;
        expires off;
    }

    location = /app {
        root /root/xln/frontend/build;
        rewrite ^ /index.html break;
        add_header Content-Security-Policy "frame-ancestors 'self' https://xln.finance https://app.xln.finance https://custody.xln.finance https://localhost:* http://localhost:*" always;
    }

    location / {
        root /root/xln/frontend/build;
        try_files $uri $uri/ /index.html;
        add_header Content-Security-Policy "frame-ancestors 'self'" always;

        location ~* \.(js|css|png|jpg|jpeg|gif|ico|svg)$ {
            expires 1y;
            add_header Cache-Control "public, immutable";
        }
    }

    location /api/ {
        proxy_pass http://localhost:8080;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
    }

    location /ws {
        proxy_pass http://localhost:8080;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
    }

    location /rpc {
        proxy_pass http://localhost:8545;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 300s;
        proxy_connect_timeout 75s;
    }
}

server {
    listen 8090 ssl http2;
    server_name xln.finance;
    ssl_certificate /etc/letsencrypt/live/xln.finance/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/xln.finance/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:18090;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_read_timeout 86400;
    }
}

server {
    listen 8091 ssl http2;
    server_name xln.finance;
    ssl_certificate /etc/letsencrypt/live/xln.finance/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/xln.finance/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:18091;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_read_timeout 86400;
    }
}

server {
    listen 8092 ssl http2;
    server_name xln.finance;
    ssl_certificate /etc/letsencrypt/live/xln.finance/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/xln.finance/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:18092;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_read_timeout 86400;
    }
}

server {
    listen 8093 ssl http2;
    server_name xln.finance;
    ssl_certificate /etc/letsencrypt/live/xln.finance/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/xln.finance/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:18093;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_read_timeout 86400;
    }
}
```

## Key Features

### Custody upstream protocol

- `custody/server.ts` serves HTTPS when `CUSTODY_HOST=localhost` and `CUSTODY_HTTPS` is unset/true.
- In that mode nginx must proxy to the custody dashboard with:
  - `proxy_pass https://127.0.0.1:8087;`
  - `proxy_set_header Host localhost:8087;`
  - `proxy_ssl_verify off;`
  - `proxy_ssl_server_name on;`
  - `proxy_ssl_name localhost;`
- If custody is started with `CUSTODY_HOST=127.0.0.1` and `CUSTODY_HTTPS=0`, then plain `http://127.0.0.1:8087` is correct instead.

### Context File Serving (/c and /c.txt)

- `/c`: Plain text display (for LLMs, curl, quick reads) - no download prompt
- `/c.txt`: Force download as `xln-context.txt` (for local saving)
- Both have:
  - Full CORS (`Access-Control-Allow-Origin: *`)
  - Aggressive no-cache (prevents stale content)
  - UTF-8 encoding

### SSL/TLS

- Wildcard certificate for `*.xln.finance`
- TLS 1.2+ only
- HSTS enabled

### Auto-redeploy

- Cron job runs `/root/xln/auto-redeploy.sh` every minute
- Triggers on commits with "redeploy" in message
- Hard resets to origin/main (server is dumb pipe)

## Deployment Steps

1. Copy this config to `/etc/nginx/sites-enabled/xln`
2. Test: `nginx -t`
3. Reload: `systemctl reload nginx`
4. Verify: `curl -I https://app.xln.finance/c`
