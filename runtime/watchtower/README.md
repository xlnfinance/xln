# Watchtower Service Map

This folder owns the standalone recovery/watchtower API service.

## What it does

- stores encrypted recovery bundles outside runtime/server.ts
- enforces per-lookup retention and byte quotas
- signs tower receipts
- serves restore/discovery APIs
- stores delayed last-resort appointments
- executes delayed counter-dispute sweeps from a standalone service boundary
- records tower action receipts for audit/debug

## Main files

- `store.ts`
  LevelDB-backed lookup storage, quota enforcement, receipt signing, and action receipts.
- `http.ts`
  HTTP handlers for appointment, restore, receipt, complaint, sweep, and action receipt endpoints.
- `action.ts`
  Delayed last-resort sweep engine. Reads last-resort appointments, watches dispute
  state, and submits tower-only counter-disputes in the final rescue window.
- `standalone-server.ts`
  Bun server entrypoint. Equivalent in spirit to `runtime/relay/standalone-server.ts`.
  Publishes `towerId`, `signerAddress`, and quota limits on `/` and `/healthz`
  so wallets can bind delayed authorizations to the exact tower address. Last-resort
  remedy payloads are encrypted to the account `watchSeed` and can only be opened
  after `DisputeStarted` reveals that seed on-chain. Health also
  exposes persisted lookup / last-resort appointment / action-receipt counts so
  operators can verify restart persistence cheaply.

## Called by

- `frontend/src/lib/stores/vaultStore.ts`
- external operators running `bun run watchtower`

## Boundary

This service is intentionally not part of `runtime/server.ts`.
Runtime correctness stays in runtime/storage/consensus. Watchtower is cheap
operator infrastructure layered on top.

Current boundary:

- yes: blind backup / restore
- yes: delayed tower counter-dispute execution path
- no: runtime-embedded tower logs or side effects
- no: general-purpose on-chain spending authority
