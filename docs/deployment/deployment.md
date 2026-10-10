# xln deployment

This is the canonical deployment document for xln.

The commands below deploy the public **testnet**. `deploy:prod` resets Anvil
and runtime data; it is not a mainnet rollout or rollback procedure. Do not use
it for a funded network. A mainnet release still requires an immutable verified
candidate, explicit network/contracts/signing authority, preserved WAL and a
recovery drill against that candidate. Reverting an executable alone does not
prove that its storage format can read the current WAL.

## Mainnet release authority — owner decision 2026-10-10

Codex prepares the release; Egor approves activation of the exact reviewed build
on `xln.finance` and signs Ethereum/TRON deployment transactions himself.

The review packet identifies the source commit, immutable artifact hashes,
destination, public identities, contract transactions, effective production
configuration, verification results and recovery/rollback procedure. Secret
values are excluded. Approval applies to these exact artifacts and settings;
rebuilding or changing the packet requires renewed approval before activation.

This boundary includes wallet frontend assets as well as signing Runtime and
service code. Preparing/uploading an inactive candidate does not authorize
switching live traffic, restarting into that candidate or executing transactions.
Rollback targets must be reviewed for compatibility with current durable state.

Production access must enforce this separation: a preparation account must not
also have unrestricted root or permission to replace active code, service units
or the release verifier. This is the agreed authority model, not a claim that
the existing root-based testnet deployment scripts already enforce it.

## Wallet-managed launch — owner scope 2026-10-10

The owner creates one BrainVault wallet and manages XLN from the wallet UI.
The earlier requirement to manually create two vaults below is superseded;
service key provisioning remains an implementation responsibility, not a second
manual owner onboarding flow. The owner's seed stays local. Service operating
keys remain separate from the owner's signing authority, and preparing a release
does not authorize its activation.

Launch jurisdictions are Ethereum, TRON and XLNC. A jurisdiction is the network
execution field, not an individual stack. Each launch stack has its own EP,
Depository, Foundation Entity #1 and onchain shares. Ordinary companies are
multisig Entities in the existing EP, with onchain shares. See
[the current XLNC scope and first gas boundary](../xlnc-soft-mainnet.md#current-owner-scope--2026-10-10).

## BrainVault provisioning package — earlier proposed design 2026-10-10

Status: design for the owner to review, not an implemented exporter or approved
production release. The authority boundary above is already agreed. No seed,
credential, contract transaction or production service is created by this document.

### Owner-held material

Create two independent BrainVault vaults locally using a reviewed build:

- Owner vault: owner-held deployment/funding keys and explicitly selected
  governance signers. Constructor recipients and Entity boards bind governance;
  the transaction deployer is not assumed to possess every administrative power.
- Mainnet infrastructure vault: the root used locally to derive service-specific
  material. It is distinct from all testnet roots and is never provisioned to a
  production orchestrator.

Retain the exact BrainVault spec, original name, factor/shard count, recovery
inputs and an offline recovery copy of each resulting mnemonic. Names/cost
presets must not be guessed during recovery. Re-derive on a fresh trusted local
session and compare the public fingerprints before funding. Keep cold recovery
material outside the agent-accessible workspace and production hosts.

The exporter must reuse canonical key derivation and record the exact role-to-
derivation mapping. Existing mesh Runtime roles use `runtime:H1`, `runtime:H2`,
`runtime:H3` and `runtime:MM`; corresponding radapter credentials are separate
from financial signers. Any missing tower/export role mapping must be specified
and tested before real identities are provisioned, rather than invented at boot.
An export format update must not silently select new identities.

### Package ownership

The following names describe proposed artifacts, not current CLI outputs:

| Artifact | Contents | Recipient |
|---|---|---|
| `public.json` | Package schema, deployment identity, role/derivation metadata, expected Runtime and Entity IDs, public signer/encryption keys, network-qualified addresses, service endpoints and secret-slot names | Owner, Codex and verifier |
| `recovery.private` | Root recovery material, exact derivation inputs/mapping and instructions for recovering each service | Owner only; encrypted/offline storage |
| Per-service secret payload | Only that role's Runtime/signing/encryption material and required credentials; no owner/infrastructure root or sibling seeds | Owner transfers directly to the intended host's provisioning service |
| `release.json` | Source SHA, executable and frontend asset digests, effective public config digest, chain/contract bindings, selected TS/Rust engine, evidence references and compatible rollback target | Owner, Codex and verifier |
| Runtime recovery bundles | Existing encrypted signed checkpoint/journal representation plus freshness metadata | Independent backup storage; owner/service recovery decrypts |

`public.json` and `release.json` never contain private keys, mnemonic words,
passphrases, bearer tokens, secret-bearing RPC URLs or hashes of secret contents.
Expected public identities establish the secret-to-role match. Sensitive RPC
credentials are referenced by slot; their values use the private provisioning path.

Each hub keeps its Ethereum/TRON Entities in the intended owning Runtime; the
two network legs are not accidentally deployed as unrelated Runtime owners.
The market maker owns its own capital and key scope. No managed end-user custody
service is implicitly enabled by provisioning the official hubs.

Tower receives its own operational key, encrypted backups and narrow signed
last-resort appointments. It receives no wallet mnemonic or general spend key.
An authorized breach/reveal can unlock the appointment payload; this is distinct
from access to ordinary encrypted backup contents.

### Creation through first launch

1. Prepare and review the local exporter, public schema and exact derivation
   mappings with disposable seeds. Prove repeat export, wrong-role rejection and
   recovery before requesting any real secret.
2. Owner creates the two vaults and verifies their fresh-session recovery locally.
   Export the public manifest; Codex can prepare deployment from public data alone.
3. Establish separate preparation and activation permissions on `xln.finance`.
   Codex can stage inactive artifacts and inspect redacted diagnostics, but cannot
   read service credentials, submit privileged Runtime commands, change active
   frontend/code/config, service units, proxy routes or the release verifier.
   Unrestricted root access would invalidate this separation.
4. Owner verifies the host fingerprint independently and provisions each role
   directly over authenticated SSH via stdin. Do not pass secrets in argv,
   command history, chat, git, build context, logs or RuntimeInput/WAL. The host
   installer recomputes public identities and rejects a mismatch, duplicate role,
   wrong deployment or unexpected overwrite before starting a service.
5. Service credentials are durable host-protected files/credentials readable by
   the intended service. Use the existing inherited secret pipe or native secret
   file interface at startup. The proposed default is automatic restart of the
   already-approved release; this requires service secrets to remain recoverable
   on that host. Host root compromise can expose its hot keys. Restart never
   authorizes a new release, new identity, database reset or secret rotation.
6. Freeze one verified release. Codex supplies per-network deployment payloads
   with constructor arguments, signer/recipient, fee/resource bounds, expected
   contract code and transaction dependencies. Owner signs locally. After each
   dependency is mined, bind its actual address and verified code to the next
   payload and final configuration; do not guess addresses or reuse signatures
   across networks. Foundation/governance recipients are reviewed explicitly.
7. Owner approves the final artifact/configuration digests after contract
   bindings are known. A host-side activation mechanism verifies that approval
   and those exact bytes. Changes require a new approval; activation does not
   rebuild from mutable source or fetch a new latest image.
8. Start the approved services with real network adapters, testnet reset/faucet
   routes disabled and the existing durable state preserved. Verify network IDs,
   Runtime/Entity/signing identities, contract bindings, relay connectivity and
   independent backup/tower health. Fail closed on any mismatch.
9. Owner funds the explicitly reviewed gas/resource and liquidity addresses.
   Run agreed-value real-network payment, swap, move, dispute and recovery
   journeys. Operational Runtime signatures are automatic under its canonical
   rules; the owner does not manually sign every routed payment. A submitted
   transaction or healthy process alone is not a completed financial operation.
10. Enable the public entry point after the required evidence is green. Preserve
    release receipts, transaction hashes, current state and recovery evidence.
    Subsequent updates repeat the immutable-candidate/owner-approval procedure.

### Loss, recovery and updates

Seed recovery restores keys, not the latest Account balances or commitments.
Restore the same service identity with its authentic, sufficiently fresh
checkpoint/WAL or existing encrypted recovery bundles, then check roots, money
and outstanding deliveries before reopening financial traffic. The role mapping
is required: opening the infrastructure root as a normal wallet does not restore
all derived service Runtimes. Missing state is a loud recovery failure, never
permission to bootstrap a fresh wallet or zero a live database.

Keep backup data outside the production host's failure domain. A tower on the
same machine cannot defend against that machine's total outage. Independently
hosted tower operation is recommended; shared-host keys are not independent
security domains merely because their filenames differ. Key compromise requires
the applicable signed rotation/revocation process, not a directory rename.

### Existing support and implementation gaps

Existing primitives: mesh child derivation, BrainVault fingerprint checks,
private child-process secret pipes, native secret-file loading, signed encrypted
Runtime recovery bundles and scoped tower appointments. The BrainVault node
custody path deliberately persists its mnemonic on the node; it must not be
used to derive the cold owner/infrastructure vaults.

Still required: the local exporter and owner provisioning flow; root-free
production secret loading (the current orchestrator requires a mesh root even
with overrides); complete service credential loading including tower; enforced
preparation/activation permissions and owner approval verification; and a
state-preserving mainnet rollout/recovery path. Existing `deploy:prod` remains
public-testnet-only and must not be used to implement this plan with real funds.

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
- `https://xln.finance/api/*` proxies to the core/orchestrator server
- `https://xln.finance/ws` upgrades to the runtime WS surface
- `https://xln.finance/rpc` proxies to local anvil/RPC
- `/c` and `/c.txt` expose the plain-text context surface for LLMs and quick reads

### Local services

- core/orchestrator HTTP + WS: `127.0.0.1:8080`
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
4. Proxy `/rpc` and `/rpc2`...`/rpc8` to the orchestrator RPC safety filter.
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
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}

location = /rpc {
    proxy_pass http://localhost:8080;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_read_timeout 300s;
    proxy_connect_timeout 75s;
}

location ~ ^/rpc[2-8]$ {
    proxy_pass http://localhost:8080;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_read_timeout 300s;
    proxy_connect_timeout 75s;
}
```

### `/ui/` — the React wallet

`https://xln.finance/ui/` serves `ui/dist` built with `bun run build:hosted`
(vite `base=/ui/`, router basename and runtime bundle follow it). The build
lives in a separate worktree (`/root/xln-ui`, detached at `origin/main`) so a
UI deploy never changes the checkout the pm2 services run from:

```bash
bun run deploy:ui        # = ssh root@xln.finance 'bash -s' < scripts/deployment/deploy-ui.sh
```

nginx (inside the 443 server block, before `location /`):

```nginx
location = /ui { return 301 /ui/; }
location ^~ /ui/ {
    alias /root/xln-ui/ui/dist/;
    try_files $uri $uri/ /ui/index.html;
    add_header Content-Security-Policy "frame-ancestors 'self'" always;
    location ~* /ui/assets/ { expires 1y; add_header Cache-Control "public, immutable"; }
    location ~* /ui/(runtime|account-worker)\.js$ { add_header Cache-Control "no-store, must-revalidate"; }
}
```

The wallet loads `/ui/runtime.js` (its own bundle pair) and talks to the same
`/api/*`, `/ws` and `/relay` surfaces as the SvelteKit app.

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

- `xln` or `xln-server` for the core/orchestrator
- `xln-custody` for the custody stack when enabled
- `xln-anvil` for local anvil/testnet if used
- `xln-relay` only if relay is still deployed as a separate process

If relay is already absorbed by the main server path, do not keep an extra
relay deploy path alive just because an older doc mentioned it.

### Relay deployment

If relay remains separate:

```bash
pm2 start core/network/relay/standalone-server.ts \
  --name xln-relay \
  --interpreter bun \
  -- --port 9000 --host 127.0.0.1
```

Expose it through nginx if a public `/relay` endpoint is still required.

### Anvil / testnet bootstrap

Typical local/prod-like bootstrap:

```bash
pm2 start scripts/operations/start-anvil.sh --name xln-anvil --interpreter bash
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
- `bun run deploy:prod` always rebuilds the public testnet from a clean Anvil, runtime, mesh, and custody state
- do not restore hub or market-maker WAL during a normal deploy; those bootstrap identities are recreated deterministically
- `bun run deploy:prod:fresh` is an explicit alias for the same clean deployment policy

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
