# Runtime Map

This README is the entry point for reading the XLN runtime. It is not a full
file catalog. The goal is to show where protocol truth lives, which modules are
infrastructure, and which folders are generated or scenario-only.

## Read Order

If you only have 1-2 hours, read files in this order:

1. `runtime.ts`
   Runtime loop, persistence boundary, ingress, exports.
2. `entity-consensus.ts`
   Entity-frame proposer/validator/commit flow.
3. `account-consensus.ts`
   Bilateral account-frame proposer/validator/commit flow.
4. `entity-tx/apply.ts`
   Entity-tx dispatcher and domain entry points.
5. `account-tx/apply.ts`
   Bilateral account-tx dispatcher.
6. `cross-jurisdiction.ts`
   Cross-j route lifecycle helpers, fill monotonicity, route FSM guardrails.
7. `storage/README.md`
   Snapshot/WAL/materialization/canonical-hash map.
8. `server/README.md`
   Public API surface for runtime, relay, discovery, control, and faucet.
9. `watchtower/README.md`
   Standalone recovery/watchtower API service backed by LevelDB.

## Core Domains

- `runtime.ts`
  Owns the runtime loop, frame persistence, env lifecycle, and top-level API.
- `entity-consensus.ts`, `entity-consensus/`
  Own entity-frame consensus, proposal hashing, and cross-j orderbook orchestration.
- `account-consensus.ts`, `account-consensus/`
  Own bilateral frame consensus, replay protection, and dispute proof updates.
- `entity-tx/`
  Applies entity-layer transactions, J-events, disputes, settlement, cross-j coordination.
- `account-tx/`
  Applies bilateral txs such as payment, HTLC, pull, swap, settlement-side actions.
- `storage/`
  Durable truth: snapshot, WAL, materialized docs, canonical hash verification.
- `networking/`, `relay/`, `relay-router.ts`, `relay-local-delivery.ts`
  Transport only. These modules deliver inputs; they do not define financial truth.
- `server.ts`, `server/`
  Runtime HTTP/WS surface, health, faucet, ingress receipts, tower/recovery APIs.
- `jadapter/`
  J-layer bridge. `rpc.ts` is production-testnet relevant. BrowserVM adapters are legacy/dev-oriented.
- `orderbook/`, `routing/`
  Same-j swap matching, book state, graph routing, and pathfinding.

## Folder Readmes

- [account-tx/README.md](/Users/zigota/xln/runtime/account-tx/README.md)
- [entity-tx/README.md](/Users/zigota/xln/runtime/entity-tx/README.md)
- [storage/README.md](/Users/zigota/xln/runtime/storage/README.md)
- [networking/README.md](/Users/zigota/xln/runtime/networking/README.md)
- [server/README.md](/Users/zigota/xln/runtime/server/README.md)
- [jadapter/README.md](/Users/zigota/xln/runtime/jadapter/README.md)
- [recovery/README.md](/Users/zigota/xln/runtime/recovery/README.md)

## Surface Classification

### Protocol-critical

These files define correctness and are the first audit target:

- `runtime.ts`
- `entity-consensus.ts`
- `account-consensus.ts`
- `entity-tx/`
- `account-tx/`
- `cross-jurisdiction.ts`
- `j-batch.ts`
- `storage/`

### Infrastructure, not protocol truth

- `server.ts`, `server/`
- `networking/`
- `relay/`
- `orchestrator/`
- `radapter/`

### Scenario / dev / operator tooling

- `scripts/`
- `scenarios/`
- `runtime-ascii.ts`
- `qa/`

### Generated or compatibility surface

- `xln-api.ts`
- `types.ts`

`xln-api.ts` is a frontend-facing compatibility/export surface.
`types.ts` is a compatibility barrel while the codebase still migrates to
domain types under `runtime/types/`.
Contract bindings are generated under `jurisdictions/typechain-types/`; do not
recreate a second runtime-local typechain copy.

## Cleanup Targets

These are the current safe simplification targets:

- keep BrowserVM adapters out of the default public-testnet reading path
- continue replacing internal `./types` imports with narrower domain type modules
- keep generated contract bindings and scenario tooling out of protocol reviews
- avoid adding new root-level helper files when a domain folder already exists

## Safe Cleanup Rule

Do not mechanically move consensus/apply files while behavior is changing.
Stabilize behavior first, then do one move-only pass.
