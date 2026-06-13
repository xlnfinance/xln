# manual dev server checks

Normal e2e runs do not require a pre-running dev server. Use `bun run test:e2e:fast` or `bun runtime/scripts/run-e2e-parallel-isolated.ts`; the isolated runner starts its own Anvil, runtime API, Vite frontend, and DB root per shard.

Use this file only when debugging a manually started local dev server.

## Start

```bash
bun run dev
```

## Check Frontend

```bash
curl -k https://localhost:8080
```

The local dev frontend is HTTPS-first. If HTTP does not respond on port 8080, that is expected when certificates are enabled.

## Check Anvil

```bash
curl -s -X POST http://localhost:8545 \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}'
```

## Check Runtime Build Artifact

```bash
ls -lh frontend/static/runtime.js
```

## Prefer Isolated Testing

```bash
bun run test:e2e:fast
bun runtime/scripts/run-e2e-parallel-isolated.ts --pw-project=chromium --pw-files=tests/e2e-payment-smoke.spec.ts
```
