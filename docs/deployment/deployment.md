# XLN Deployment

This is the canonical deployment doc for XLN.

It replaces the older split between:
- `server-setup.md`
- `relay-deployment.md`
- `testnet-setup.md`

Those files were moved to `docs/archive/deployment/`.

## Scope

This doc covers:
- the production nginx surface on `xln.finance`
- runtime + relay + custody process expectations
- the anvil/testnet bootstrap path
- the minimum verification steps after deploy

For live health, alerting, and storage incident response, use
[ops-runbook.md](ops-runbook.md).

## Deployment Topology

### Public surface

- `https://xln.finance/` and `https://app.xln.finance/` serve the frontend
- `https://xln.finance/api/*` proxies to the runtime/orchestrator server
- `https://xln.finance/ws` upgrades to the runtime WS surface
- `https://xln.finance/rpc` proxies to local anvil/RPC
- `/c` and `/c.txt` expose the plain-text context surface for LLMs and quick reads

### Local services

- runtime/orchestrator HTTP + WS: `127.0.0.1:8080`
- relay: `127.0.0.1:9000` when deployed separately
- anvil RPC: `127.0.0.1:8545`
- custody dashboard/service: `127.0.0.1:8087`
- custody daemon/runtime: `127.0.0.1:8088`

## Production Nginx Notes

Canonical file location:

```text
/etc/nginx/sites-enabled/xln
```

Required capabilities:

1. Serve the built frontend over HTTPS.
2. Proxy `/api/` to the runtime server.
3. Proxy `/ws` with WebSocket upgrade headers.
4. Proxy `/rpc` to local anvil/RPC with enough read timeout.
5. Serve `/c` and `/c.txt` with permissive CORS and aggressive no-cache.
6. Preserve the frame-ancestor policy expected by app and custody surfaces.

### Required proxy surfaces

```nginx
location /api/ {
    proxy_pass http://localhost:8080;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection 'upgrade';
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
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
```

### `/c` and `/c.txt`

Keep both endpoints:

- `/c` for direct text display
- `/c.txt` for explicit download

Both should have:
- `Access-Control-Allow-Origin "*"`
- no-cache headers
- UTF-8 text content type

### Custody upstream note

If custody serves HTTPS on `localhost`, nginx must proxy with TLS to
`https://127.0.0.1:8087` and disable local cert verification for that upstream.
If custody is configured as plain HTTP on loopback, normal `http://127.0.0.1:8087`
proxying is fine.

## Process Model

### PM2-managed services

Recommended expectation:

- `xln` or `xln-server` for the runtime/orchestrator
- `xln-custody` for the custody stack when enabled
- `xln-anvil` for local anvil/testnet if used
- `xln-relay` only if relay is still deployed as a separate process

If relay is already absorbed by the main server path, do not keep an extra
relay deploy path alive just because an older doc mentioned it.

### Relay deployment

If relay remains separate:

```bash
pm2 start runtime/relay/standalone-server.ts \
  --name xln-relay \
  --interpreter bun \
  -- --port 9000 --host 127.0.0.1
```

Expose it through nginx if a public `/relay` endpoint is still required.

### Anvil / testnet bootstrap

Typical local/prod-like bootstrap:

```bash
pm2 start scripts/start-anvil.sh --name xln-anvil --interpreter bash
pm2 save
```

Runtime startup should set the RPC path explicitly:

```bash
export ANVIL_RPC=http://localhost:8545
export USE_ANVIL=true
```

## Deploy Ownership Rules

- do not rely on legacy auto-redeploy cron drift
- deploy from an explicit operator/release script
- keep the repo clean before deploy except approved runtime data outside git
- after deploy, verify health instead of assuming a process restart means success

## Verification Checklist

After deploy:

```bash
nginx -t
systemctl reload nginx
pm2 status
curl -fsS https://xln.finance/api/health | jq '{coreOk, systemOk, degraded}'
curl -fsS https://xln.finance/api/metrics | grep -E 'xln_(core_ok|system_ok)'
curl -I https://xln.finance/c
```

If anvil/testnet is part of the environment:

```bash
curl https://xln.finance/rpc \
  -X POST \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}'
```

If public relay remains enabled:

```bash
curl -i -N \
  -H "Connection: Upgrade" \
  -H "Upgrade: websocket" \
  -H "Sec-WebSocket-Version: 13" \
  -H "Sec-WebSocket-Key: test" \
  https://xln.finance/relay
```

Expected result: `101 Switching Protocols`.

## Troubleshooting Priorities

1. nginx config sanity: `nginx -t`
2. PM2 child health: `pm2 status`, `pm2 logs --lines 200`
3. public health surface: `/api/health`, `/api/metrics`
4. disk pressure and log growth
5. anvil/RPC responsiveness
6. relay connectivity only if relay is still a separate concern

## Historical Sources

If you need the old step-by-step or exact legacy wording:

- `docs/archive/deployment/server-setup-legacy.md`
- `docs/archive/deployment/relay-deployment-legacy.md`
- `docs/archive/deployment/testnet-setup-legacy.md`
