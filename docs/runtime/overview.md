# Runtime Code Map

This document is the entry point for reading the xln runtime. It is not a full
file catalog. The goal is to show where protocol truth lives, which modules are
infrastructure, and which folders are generated or scenario-only.

## Read Order

If you only have 1-2 hours, read files in this order:

1. `runtime/runtime.ts`
   Public runtime API and compatibility entry point.
2. `runtime/machine/lifecycle.ts`, `runtime/machine/input-queue.ts`, `runtime/machine/entity-inputs.ts`, `runtime/machine/output-routing.ts`
   Single-writer loop, ingress, entity dispatch, and durable output routing.
3. `runtime/entity/consensus/index.ts`, `runtime/entity/consensus/frame.ts`, `runtime/entity/consensus/leader.ts`
   Entity-frame proposal, quorum validation, commit, and ordered leader failover.
4. `runtime/account/consensus/index.ts`, `runtime/account/consensus/frame.ts`, `runtime/account/consensus/deadline-policy.ts`
   Bilateral account proposal/ACK, secondary-manifest validation, and receiver-local deadline policy.
5. `runtime/entity/tx/apply.ts`
   Entity-tx dispatcher and domain entry points.
6. `runtime/account/tx/apply.ts`
   Bilateral account-tx dispatcher.
7. `runtime/jurisdiction/history-consensus.ts`, `runtime/jurisdiction/event-observation.ts`, `runtime/machine/j-submit.ts`
   Per-validator J-block histories, quorum-prefix finality, observation, and durable submission.
8. `runtime/storage/`, `runtime/wal/snapshot.ts`
   Snapshot/WAL/materialization and local integrity hashes.
9. `runtime/extensions/cross-j/`, `runtime/orderbook/`
   Cross-j lifecycle and same-j market extensions outside the minimal payment core.
10. `runtime/networking/`, `runtime/relay/`, `runtime/server/`
    Transport and operator surfaces; these do not define financial truth.

## Core Domains

- `runtime/runtime.ts`
  Owns the runtime loop, frame persistence, env lifecycle, and top-level API.
- `runtime/machine/`
  Owns lifecycle, input admission, scheduled wakes, routing, and persistence orchestration.
- `runtime/entity/consensus/`
  Own entity-frame consensus, proposal hashing, and cross-j orderbook orchestration.
- `runtime/account/consensus/`
  Own bilateral frame consensus, replay protection, and dispute proof updates.
- `runtime/entity/tx/`
  Applies entity-layer transactions, J-events, disputes, settlement, cross-j coordination.
- `runtime/account/tx/`
  Applies bilateral txs such as payment, HTLC, pull, swap, settlement-side actions.
- `runtime/jurisdiction/`
  Groups validator observations by jurisdiction block and finalizes only the exact quorum-supported prefix.
- `runtime/storage/`, `runtime/wal/`
  Durable truth: snapshot, WAL, materialized docs, canonical hash verification.
- `runtime/networking/`, `runtime/relay/`
  Transport only. These modules deliver inputs; they do not define financial truth.
- `runtime/server/`
  Runtime HTTP/WS surface, health, faucet, ingress receipts, tower/recovery APIs.
- `runtime/jadapter/`
  J-layer bridge. `rpc.ts` is production-testnet relevant. BrowserVM adapters are legacy/dev-oriented.
- `runtime/orderbook/`, `runtime/routing/`
  Same-j swap matching, book state, graph routing, and pathfinding.

## Folder Readmes

- [Runtime machine](./machine.md)
- [Entity machine](./entity.md)
- [Account machine](./account.md)
- [Jurisdiction machine](./jurisdiction.md)
- [Protocol primitives](./protocol.md)
- [Runtime extensions](./extensions.md)
- [Account transactions](./account-transactions.md)
- [Entity transactions](./entity-transactions.md)
- [Storage](./storage.md)
- [Networking](./networking.md)
- [Server](./server.md)
- [Jurisdiction adapter](./jadapter.md)
- [Recovery](./recovery.md)
- [Watchtower](./watchtower.md)

## Surface Classification

### Protocol-critical

These files define correctness and are the first audit target:

- `runtime/runtime.ts`
- `runtime/machine/`
- `runtime/entity/consensus/`
- `runtime/account/consensus/`
- `runtime/entity/tx/`
- `runtime/account/tx/`
- `runtime/jurisdiction/`
- `runtime/storage/`
- `runtime/wal/`

### Infrastructure, not protocol truth

- `runtime/server/`
- `runtime/networking/`
- `runtime/relay/`
- `runtime/orchestrator/`
- `runtime/radapter/`

### Scenario / dev / operator tooling

- `runtime/scripts/`
- `runtime/scenarios/`
- `runtime/qa/runtime-ascii.ts`
- `runtime/qa/`

### Generated or compatibility surface

- `runtime/xln-api.ts`
- `runtime/types.ts`

`runtime/xln-api.ts` is a frontend-facing compatibility/export surface.
`runtime/types.ts` is a compatibility barrel while the codebase still migrates to
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
