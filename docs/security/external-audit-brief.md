# XLN External Security Audit Brief

This is the handoff brief for an independent reviewer before any open testnet or mainnet exposure. The goal is not a broad style review. The goal is to prove that runtime consensus, storage recovery, J-layer settlement, transport ingress, and cross-jurisdiction swaps fail closed under adversarial inputs.

## Scope

Review these surfaces first:

- Runtime frame loop, ingress, and durable commit semantics.
- Entity consensus and account consensus proposer/receiver paths.
- Entity/account tx handlers that mutate balances, pulls, swaps, disputes, or J-batches.
- Storage projection, hydration, WAL replay, canonical hash verification, and restore fail-fast behavior.
- JAdapter RPC path from `processBatch` submission to event normalization and runtime ingestion.
- Cross-jurisdiction delayed-clearing route lifecycle and orderbook cleanup.
- Relay/direct transport trust boundaries, including encrypted-only ingress and hub-only direct endpoints.
- Production deploy, health, and release-gate scripts.
- User-facing Pay, same-account Swap, and Cross-j Swap coverage through the
  shared frontend surfaces and their E2E tests.

Out of scope unless a scoped issue depends on it:

- Editorial product copy.
- Non-production scenario-only demos.
- BrowserVM simulator internals, except where they can affect server/RPC
  runtime state.
- Experimental side apps outside runtime, custody, native shell security, and frontend payment surfaces.

## Main Invariants

- Every financial state transition is deterministic and replayable from persisted runtime frames.
- Snapshot plus WAL plus frame history restores exactly the canonical runtime state, or startup fails before the loop begins.
- Every externally accepted input is eventually committed, explicitly rejected, deferred with visible reason, or treated as a fatal invariant violation.
- `runtime_input` and plaintext `entity_input` cannot enter runtime state from any network ingress.
- J-events are authenticated validator observations over the canonical event set, and real RPC settlement logs normalize to the same event hash consumed by runtime.
- Jurisdiction identity is stack identity (`chainId` plus depository address), never a text alias.
- Cross-j routes are written by the route lifecycle only; direct account tx helpers cannot bypass filled-route clearing rules.
- Production storage bypass flags and repair shortcuts are unavailable without explicit dev/test intent.

## Required Commands

The reviewer should run these commands from a clean checkout and include exact versions, commit hash, and logs in the report:

```bash
bun run gate:ci
bun run test:e2e:coverage
bun run test:rpc-settlement
bun run soak:quick
bun run prod:health
```

Before mainnet approval, also run the full release bar:

```bash
bun run gate:release
bun run soak:release
```

The soak release command is deliberately long. It is the operational evidence for restart/load stability, not a unit-test substitute.

## High-Risk Files

- `runtime/runtime.ts`
- `runtime/entity-consensus.ts`
- `runtime/account-consensus.ts`
- `runtime/entity-tx/apply.ts`
- `runtime/entity-tx/j-events.ts`
- `runtime/entity-tx/handlers/account.ts`
- `runtime/entity-tx/handlers/account-cross-j-followups.ts`
- `runtime/account-tx/handlers/pull.ts`
- `runtime/account-tx/handlers/swap-resolve.ts`
- `runtime/cross-jurisdiction.ts`
- `runtime/cross-jurisdiction-orderbook.ts`
- `runtime/storage/read.ts`
- `runtime/storage/projections.ts`
- `runtime/storage/canonical-hash.ts`
- `runtime/jadapter/rpc.ts`
- `runtime/jadapter/helpers.ts`
- `runtime/relay-router.ts`
- `runtime/networking/p2p.ts`
- `runtime/networking/direct-runtime-bun.ts`
- `runtime/networking/ws-client.ts`
- `jurisdictions/contracts/Depository.sol`
- `jurisdictions/contracts/EntityProvider.sol`
- `jurisdictions/contracts/Account.sol`

## Known Non-Goals

- Do not propose repair-on-restore or quarantine behavior for production storage corruption. Production should fail closed.
- Do not route cross-jurisdiction control messages through generic public P2P unless a new signed inter-runtime protocol is explicitly designed and reviewed.
- Do not treat "queued" HTTP responses as committed payments.
- Do not accept BrowserVM-only evidence for J-layer correctness. BrowserVM is a
  dev/demo simulator for now; the public-testnet gate is RPC/anvil only.

## Auditor Deliverables

The final report must include:

- Verdict: `SAFE`, `SAFE-with-caveats`, or `UNSAFE`.
- Findings ordered by severity with file/line references.
- Concrete exploit or failure scenario for each finding.
- The violated invariant and root cause.
- Minimal root fix, not a repair workaround.
- Regression test required for each finding.
- False positives checked.
- Exact commands run and pass/fail status.

The report is not complete if it does not cover storage restore, J-event authentication, cross-j route lifecycle, and network ingress.
