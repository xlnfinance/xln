# Core audit, 2026-11-14

Four read-only passes at `da08764cc`: bilateral Account consensus, TypeScript against Solidity
settlement, Runtime halts and effect ordering, repository consistency. Each row was checked
against the code; "reproduced" means a test demonstrates it.

## Fixed and landed

| Finding | Fix | Test |
|---|---|---|
| A peer could halt a Runtime by sending back our committed head with its own ACK Hanko while our successor was pending (untyped `DUPLICATE_ACK_CURRENT_FRAME_HANKO_INVALID`). | `4d59c8901`: typed `ACCOUNT_INPUT_FRAME_HANKO_INVALID` reject. | `core/__tests__/security/policy/peer-own-head-replay.test.ts` (red without the fix) |
| A hub restarted from a checkpoint halted on its first swap offer: the canonical J replica snapshot dropped `tokenRegistry`, which same-J matching reads (regression from `3cd8c5380`). | `4280df1eb`: the snapshot and its schema keep the registry. | `core/__tests__/jurisdiction/history/jreplica-token-registry-snapshot.test.ts` |

## Reproduced, needs an owner decision

| Finding | Evidence |
|---|---|
| Dispute-proof replay after finalization: a pre-dispute proof with a higher nonce is settled a second time against the emptied account. | [dispute-replay-20261114](../dispute-replay-20261114/readme.md) |

## Confirmed by reading, needs an owner decision

- **A swap taker can fill 100% in a dispute without the capacity TS requires.** TS rejects a fill
  beyond the counterparty's `outCapacity` (`core/account/tx/handlers/swap/resolve/settlement.ts`);
  `DeltaTransformer.applySwap` applies both legs from the counterparty's fill ratio with no view of
  collateral or credit. A maker's secured give side can become an unsecured claim on the hub.
  Fixing it at admission restricts hub order books.
- **Beneficiary HTLC timeout: proposer and receiver disagree.** Preflight admits
  `htlc_resolve {error, reason: 'timeout'}` on the frame clock
  (`core/account/consensus/dispute/deadline-policy.ts`); receiver replay uses its own clock
  (`core/account/tx/handlers/htlc/resolve.ts`) and a rejected replay opens a dispute between honest
  peers. Either make preflight a typed reject or let a beneficiary release regardless of the reason.
- **HTLC expiry by J height exists only in TS.** `core/account/htlc-deadline.ts` expires on height or
  timestamp; `DeltaTransformer` checks the timestamp only. On a chain faster than its configured
  block time a payer can cancel upstream while downstream is still enforceable.
- **Early savings exit pays more through a dispute than cooperatively** (principal plus pro-rata
  interest against principal only). Documented as intended in `lending-covenant.ts`.

## Leads not yet verified

- **Remote `registerCrossJurisdictionSwap` may trip `CROSS_J_LOCAL_SIBLING_MISSING`**, a plain throw
  in `assertCrossJLocalCohorts` after the tx loop. Ingress only checks
  `prepareCrossJurisdictionSwap`. Not traced through `assertRuntimeOutputSemanticAuthority`.
- **`cross_pull_lock` does not bind payer or amount to the route at the Account layer**
  (`core/account/tx/handlers/settlement/pull.ts`); the binding lives in Runtime ingress only.
- **Settlement Hanko nonce is validated against replica-private cursors**
  (`core/account/tx/handlers/settlement/transition.ts`).
- **`registerServerJurisdiction` builds a J replica without a token registry**
  (`core/api/server/index.ts`); any orderbook Entity on that server would halt on a swap offer.
- **A throw in post-commit dispatch skips that frame's reject policy**
  (`core/runtime/frame/lifecycle/post-commit.ts`).
- **The token registry is frozen at import time**: tokens listed afterwards are zero-fill cancelled.
- **Swap dispute rounding** floors both legs at 1/65535 and charges no taker fee.

## Consistency, still open

- `core/scripts/release/run-release-gate.ts` runs React wallet E2E only and calls Svelte frozen.
- `tools/xln1000/axes/canonical.ts` and `journeys.ts` label Svelte and Rust frozen, count only
  React specs, and point at a moved scenario (`core/scenarios/payments/lock-ahb.ts`). Manifests are
  owner-only.
- `core/runtime/config/account-execution.ts` rejects `XLN_HLT_ENGINE=rust` as retired.
- Token id 1 is typed `USDT` in `core/jurisdiction/gossip/announcement.ts` and the stack manager;
  the catalog has id 1 = USDC.
- `ui/package.json` and `rscore/Cargo.toml` are 0.1.0 while `VERSION` is 0.1.31.
- Fee and price formulas duplicated in the wallets: `ui/src/runtime/financial/manage.ts`
  (`collateralFee`), two hop-fee formulas in `frontend/src/lib/components/Entity/`, and
  `swap-order-math.ts` constants.
- `docs/wal.md` describes a storage API and config keys that do not exist;
  `docs/consensus-invariants.md` names `processAccountTx` and `account-consensus.ts`.
- 55 lines in 26 files still state the mission as 51% of world GDP.
