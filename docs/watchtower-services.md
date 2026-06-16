# Tower Backup and Last-Resort Dispute Services

**[Index](readme.md)** | **[Status](status.md)** | **[Mainnet Bar](mainnet.md)** | **[Protocol](recovery-watchtower-protocol.md)**

This is the operational contract for the current tower service. Product copy
should call the two capabilities:

- **Encrypted backup**
- **Last-resort dispute protection**

The implementation may run both capabilities in one standalone tower daemon.
They remain separate services in protocol terms: different lookup namespaces,
different payloads, different failure modes, and different user promises.

## Current Model

### Encrypted backup

- Upload mode: `blind_backup`.
- Lookup key: `deriveRuntimeRecoveryLookupKey(runtimeId, runtimeSeed)`.
- Payload: encrypted runtime recovery snapshot or journal tail.
- Encryption: AES-GCM key derived from `runtimeId + runtimeSeed`.
- Tower can see lookup key, height, size, timestamps, bundle hash, and receipt
  metadata.
- Tower cannot decrypt balances, proof bodies, WAL frames, signers, gossip
  profiles, or runtime state.
- Restore target: wiped browser, lost local DB, restart after storage loss.

### Last-resort dispute protection

- Upload mode: `delayed_last_resort`.
- Lookup key: `deriveRuntimeRecoveryActionLookupKey(runtimeId, runtimeSeed,
  entityId, counterentity)`.
- Payload: latest counter-dispute appointment for one watched account pair.
- Encryption: `encryptedRemedy` is AES-GCM encrypted with the account
  `watchSeed`.
- Decryption trigger: the tower learns `watchSeed` only from a J-layer
  `DisputeStarted` event.
- Tower action: only `watchtowerCounterDispute(...)` with a strictly newer
  proof inside the last-resort window.
- Tower cannot start disputes, same-proof finalize, or spend user funds.

## Privacy Contract

Before breach:

- Backup contents are opaque to the tower.
- Last-resort remedies are opaque to the tower.
- The tower can monitor only the chain/account pair declared in
  `lastResortPayload.watch`: RPC URL, chain id, depository, watched entity, and
  counterentity.
- The tower sees `triggerHint`, proof nonce, proof body hash, appointment
  sequence, and timing policy. It does not see balances/offdeltas/remedy
  calldata.

On breach:

- `DisputeStarted` publishes the proof body's `watchSeed`.
- The tower derives the remedy key and decrypts `encryptedRemedy`.
- The tower verifies the decrypted remedy matches the stored appointment,
  active dispute event, proof body hash, proof nonce, watched account, tower
  address, and last-resort window.
- Backup bundles remain encrypted to the restored wallet. Revealing
  `watchSeed` does not decrypt runtime backups.
- If a tower retained old last-resort appointments, the revealed `watchSeed`
  may decrypt those retained action payloads too. The sweep engine still chooses
  only the latest appointment by `appointmentSequence`, then `proofNonce`, then
  bundle height/creation order.

## Daemon Surfaces

Public endpoints:

```txt
GET  /
GET  /healthz
GET  /api/tower/healthz
PUT  /api/tower/appointment
POST /api/tower/restore
GET  /api/tower/receipt/:lookupKey
POST /api/recovery/discover
POST /api/recovery/state
POST /api/recovery/complaint
```

Operator endpoints:

```txt
POST /api/watchtower/sweep
GET  /api/watchtower/actions/:lookupKey
```

Rules:

- Operator API is disabled unless `--enable-operator-api` or
  `XLN_WATCHTOWER_OPERATOR_API=1` is set.
- Public bind with operator API requires `XLN_WATCHTOWER_OPERATOR_TOKEN`.
- Complaint intake is disabled unless `XLN_WATCHTOWER_ACCEPT_COMPLAINTS=1`.
- Last-resort scheduler is disabled unless `--enable-last-resort-agent` or
  `XLN_WATCHTOWER_ENABLE_LAST_RESORT=1` is set.
- Last-resort scheduler and sweep require `XLN_WATCHTOWER_PRIVATE_KEY`.

## Configuration

Backup-only tower:

```bash
bun runtime/watchtower/standalone-server.ts \
  --host 0.0.0.0 \
  --port 9100 \
  --db data/watchtower \
  --max-bundles 3 \
  --quota-bytes 4194304
```

Backup plus last-resort disputer:

```bash
XLN_WATCHTOWER_PRIVATE_KEY=0x... \
XLN_WATCHTOWER_OPERATOR_TOKEN=... \
XLN_WATCHTOWER_ALLOWED_RPC_URLS=https://xln.finance/rpc,https://xln.finance/rpc2,https://xln.finance/rpc3,https://xln.finance/rpc4,https://xln.finance/rpc5,https://xln.finance/rpc6,https://xln.finance/rpc7,https://xln.finance/rpc8 \
bun runtime/watchtower/standalone-server.ts \
  --host 0.0.0.0 \
  --port 9100 \
  --db data/watchtower \
  --enable-last-resort-agent \
  --enable-operator-api \
  --sweep-interval-ms 30000
```

Defaults:

- port: `9100`
- host: `0.0.0.0`
- retained bundles per lookup: `3`, clamped to `2..8`
- stored bytes per lookup: `4 MiB`
- receipt/action retention: 12 months
- default allowed RPC URLs: localhost `8545/8546` plus
  `https://xln.finance/rpc` through `/rpc8`

## Restore Behavior

Restore is backup-only from the user's perspective:

1. Wallet derives the backup lookup key from `runtimeId + runtimeSeed`.
2. Wallet asks configured towers for `/api/tower/restore`.
3. Tower returns the latest snapshot and compatible journal tail.
4. Wallet decrypts locally.
5. Wallet validates bundle hash, lookup key, checkpoint hash, WAL tail, signer
   metadata, and restored runtime shape.
6. Wallet re-announces restored gossip profiles so post-restore account routing
   can open accounts without a fresh hub discovery race.

The target restore SLA is under 1 minute. Current retention is designed for a
small latest-state ring, not long-term audit history.

## Dispute Sweep Behavior

For each latest delayed-last-resort appointment:

1. Normalize and allowlist the RPC URL.
2. Read current block and on-chain account state.
3. Skip if no active dispute, outside the last-resort window, or on-chain nonce
   is already at least the appointment proof nonce.
4. Find the matching `DisputeStarted` log for watched entity/counterentity.
5. Use the event `watchSeed` to decrypt `encryptedRemedy`.
6. Verify appointment sequence, proof nonce, proof body hash, chain id,
   depository, watched entity, counterentity, tower address, and final
   proofbody `watchSeed`.
7. Submit `watchtowerCounterDispute(...)`.
8. Store an action receipt with `submitted`, `skipped`, or `error`.

The contract must enforce the last-resort delay. Tower policy alone is not a
security boundary.

## Edge Cases

- Plaintext last-resort remedies are rejected by both HTTP validation and store
  insertion.
- `blind_backup` appointments must not include last-resort payloads.
- `delayed_last_resort` appointments must include encrypted remedy payloads.
- RPC URLs are normalized and checked against the allowlist before live sweeps.
- The tower records an error instead of submitting if the decrypted remedy does
  not match the watched account, tower key, proof hash, proof nonce, or
  revealed `watchSeed`.
- Latest appointment selection prefers higher `appointmentSequence`, then
  higher `proofNonce`, then newer bundle metadata.
- A same-proof or early tower action must revert on-chain.
- A stale dispute inside the last-resort window should produce exactly one
  counter-dispute submission path and a signed action receipt.

## Verification

Use the ladder, not a broad suite first.

L1 narrow:

```bash
bun test runtime/__tests__/recovery-tower.test.ts
bun test runtime/__tests__/watchtower-last-resort.test.ts
bun test tests/frontend/recovery-tower-config.test.ts
```

L2 targeted contract/RPC:

```bash
bun test runtime/__tests__/watchtower-rpc-last-resort.test.ts
```

L2 browser restore:

```bash
E2E_BASE_URL=https://localhost:8080 \
E2E_API_BASE_URL=https://localhost:8080 \
E2E_RESET_BASE_URL=http://127.0.0.1:8082 \
PW_ONLY_CHROMIUM=1 PW_FAST=1 PW_VIDEO=off PW_TRACE=off PW_SCREENSHOT=only-on-failure \
bunx playwright test tests/e2e-watchtower-recovery.spec.ts --project=chromium
```

L3 gate:

```bash
bun run check
```

Mainnet cannot claim this subsystem ready unless encrypted backup restore and
offline stale-dispute countering are both green.
