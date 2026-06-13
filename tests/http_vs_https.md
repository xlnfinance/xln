# local http vs https

The local xln frontend is HTTPS-first when development certificates are present. This is expected and matches the browser security model used by production-like testing.

## Expected Local Behavior

| URL | Expected result |
| --- | --- |
| `https://localhost:8080` | frontend loads |
| `http://localhost:8080` | may fail or return an empty reply when HTTPS certs are enabled |

## Why HTTPS

- Web crypto and secure-context APIs behave like production.
- WebXR, service workers, and browser storage paths are tested under secure-context rules.
- Playwright can ignore the local self-signed certificate through config.

## E2E Defaults

The isolated runner starts its own HTTPS frontend per shard:

```bash
bun run test:e2e:fast
```

Manual dev-server testing should use:

```bash
curl -k https://localhost:8080
```

Do not change tests to HTTP just to avoid certificate handling. If a test needs manual-server mode, pass the HTTPS base URL explicitly.
