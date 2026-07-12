# XLN auditor memo

Last updated: 2026-07-09

This file is a reading map for an external reviewer who understands TypeScript
and L2/payment-channel systems. It is not a security sign-off. Read code and
tests as authoritative.

## Current verification snapshot

- `main` pushed through commit `e206c265`.
- Latest broad gate run: `bun run check` passed on 2026-07-09.
- Recent browser smoke: `/scenarios` loaded `Hub collapse: 21 frames` with no
  page errors, no console warnings/errors, and no visible scenario error.
- Recent regression closure: `direct_payment` no longer mutates hashed
  `currentFrame.deltas`; current account frames remain hash-stable.

## Suggested reading order for 90 percent system understanding

1. Core model and invariants.
2. Runtime loop.
3. Account consensus.
4. Entity consensus.
5. Money math and tx handlers.
6. Hanko/proof/contract boundary.
7. J-layer event bridge.
8. Persistence/recovery/watchtower.
9. Remote runtime/server/frontend projection.
10. Extensions: orderbook, cross-j, routing, lending/agent payments.

## Module map

Scores are `importance / complexity` out of 100.

| Module | Score | What to read | Why it matters |
| --- | ---: | --- | --- |
| Core types and validation | 100 / 70 | `runtime/types.ts`, `runtime/types/account.ts`, `runtime/validation-utils.ts` | Defines Env/E/J/A objects, account frames, deltas, and fail-fast decode boundaries. |
| Runtime loop | 100 / 90 | `runtime/runtime.ts`, `runtime/state-helpers.ts` | Owns RJEA processing, input admission, frame progression, side effects, cloning, and history snapshots. |
| Account consensus | 100 / 95 | `runtime/account-consensus.ts`, `runtime/account/consensus/propose.ts`, `runtime/account/consensus/frame.ts` | Bilateral propose/validate/commit and account frame hash rules. This is the most important protocol code after types. |
| Account tx handlers | 95 / 85 | `runtime/account/tx/apply.ts`, `runtime/account/tx/handlers/*` | Applies payment, HTLC, pull, swap, settlement, dispute-control, and credit actions inside account consensus. |
| Entity consensus | 96 / 85 | `runtime/entity-consensus.ts`, `runtime/entity-consensus-frame.ts`, `runtime/entity/tx/apply.ts` | Entity-level BFT/proposer flow, E-frame hash, entity mempool, and tx dispatch. |
| Entity tx handlers | 95 / 85 | `runtime/entity/tx/handlers/*`, `runtime/entity/tx/j-events.ts` | Opens accounts, routes payments, handles disputes, J-batches, mints, debt, and external wallet/reserve actions. |
| Money math | 100 / 60 | `runtime/account-utils.ts`, `runtime/account/frame.ts`, `runtime/serialization-utils.ts` | `deriveDelta()` is the source of truth for bilateral capacity/economics; frame delta integrity and BigInt serialization live here. |
| Hanko and proof path | 100 / 90 | `runtime/hanko/core.ts`, `runtime/hanko/signing.ts`, `runtime/proof-builder.ts`, `runtime/dispute-arguments.ts` | Signature aggregation, proof-body hashing, dispute arguments, and Solidity-compatible signing checks. |
| Solidity contracts | 100 / 90 | `jurisdictions/contracts/EntityProvider.sol`, `Depository.sol`, `Account.sol`, `DeltaTransformer.sol`, `Types.sol` | On-chain enforcement boundary. Compare Hanko, dispute, settlement, and transformer semantics against runtime. |
| J-layer bridge | 90 / 75 | `runtime/jadapter/*`, `runtime/j-batch.ts`, `runtime/j-height.ts` | Chain adapters, batch construction, J-event ingestion, and J-height safety. |
| Storage, WAL, recovery | 95 / 85 | `runtime/storage/*`, `runtime/wal/*`, `runtime/recovery/*`, `runtime/watchtower/*` | Persistence, restore, recovery bundles, tower receipts, and last-resort account safety. |
| Networking and delivery | 85 / 80 | `runtime/networking/*`, `runtime/relay/*`, `runtime/relay/router.ts`, `runtime/delivery-result.ts` | Relay/direct/P2P delivery semantics, retries, TTLs, and freshness/liveness boundaries. |
| RAdapter and server | 85 / 80 | `runtime/radapter/*`, `runtime/server/*`, `runtime/server.ts` | Remote runtime query/control surface used by browser app and external operators. |
| Orchestrator | 75 / 85 | `runtime/orchestrator/*` | Dev/prod process supervision, hub/MM/custody/watchtower wiring. Large operational surface, not the core consensus root. |
| Orderbook and swaps | 82 / 85 | `runtime/orderbook/*`, `runtime/cross-jurisdiction.ts`, `runtime/cross-jurisdiction-orderbook.ts`, `runtime/account/tx/handlers/swap-*` | Same-j and cross-j swap lifecycle, fills, cancels, exact amount accounting, hash-ladder proof ratio boundaries. |
| Routing | 85 / 75 | `runtime/routing/*`, payment/HTLC handlers | Payment path selection, route metadata, hub compatibility, and route-capacity assumptions. |
| Scenarios and tests | 80 / 70 | `runtime/scenarios/*`, `runtime/__tests__/*`, `tests/e2e-*` | Executable examples and regression evidence. Use them to understand expected system flows. |
| Frontend stores | 75 / 80 | `frontend/src/lib/stores/xlnStore.ts`, `vaultStore.ts`, `runtimeStore.ts` | Browser runtime ownership, remote runtime hydration, persistence, error logs, and user-facing command flow. |
| App UI panels | 65 / 75 | `frontend/src/lib/components/Entity/*`, `Wallet/*`, `Runtime/*`, `frontend/src/lib/view/*` | Projection/UI layer. Important for UX and remote runtime management, less authoritative than runtime state. |

## Key files to read first

- `runtime/types.ts`
- `runtime/types/account.ts`
- `runtime/runtime.ts`
- `runtime/account-consensus.ts`
- `runtime/account/consensus/propose.ts`
- `runtime/account/consensus/frame.ts`
- `runtime/entity-consensus.ts`
- `runtime/entity-consensus-frame.ts`
- `runtime/account-utils.ts`
- `runtime/account/tx/apply.ts`
- `runtime/entity/tx/apply.ts`
- `runtime/entity/tx/handlers/dispute.ts`
- `runtime/hanko/signing.ts`
- `runtime/proof-builder.ts`
- `jurisdictions/contracts/EntityProvider.sol`
- `jurisdictions/contracts/Depository.sol`
- `jurisdictions/contracts/Account.sol`
- `runtime/storage/index.ts`
- `runtime/radapter/resolve.ts`

## Focus questions for audit

1. Can `validate == commit` diverge anywhere in account or entity consensus?
2. Can any handler mutate already-hashed frame history or proof material?
3. Are all deltas derived through `deriveDelta()` and canonical frame deltas?
4. Are J-height, dispute timeout, and event observation paths consistent across
   proposer, receiver, restore, and proof generation?
5. Can a remote runtime command bypass the same app command/admission path used
   by browser runtimes?
6. Are persistence restore and recovery bundle semantics exact enough to avoid
   replaying as the wrong signer/proposer?
7. Does cross-j exact amount accounting ever round-trip through lossy uint16
   fill ratios?
8. Are expected empty/transient/fatal failures typed clearly enough for health,
   relay, bootstrap, and operator tooling?
9. Are signing keys and raw seed material still present in persisted/runtime
   artifacts? This is intentionally deferred but remains a mainnet blocker.
10. Does any extension path bypass core account invariants, `deriveDelta()`, or
    the account consensus frame hash boundary?
