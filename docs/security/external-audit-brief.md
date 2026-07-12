# XLN External Security Audit Brief

This is the handoff brief for an independent reviewer before any open testnet or mainnet exposure. The goal is not a broad style review. The goal is to prove that runtime consensus, storage recovery, J-layer settlement, transport ingress, and cross-jurisdiction swaps fail closed under adversarial inputs.

Last refreshed: 2026-07-09. Current internal evidence includes green
`bun run security:audit-pack` and green `bun run check` on 2026-07-09, focused
remote-runtime import/switch browser coverage on 2026-07-09, green
`bun run security:contract-governance`, `bun run security:consensus-hanko`, and
`bun run security:failure-taxonomy`, `bun run security:delivery-boundary`,
`bun run security:canonical-identity`, `bun run security:canonical-fill`, and
`bun run security:swap-cancel-canonical` on 2026-07-09, and a green
`bun run test:all:fast` run on 2026-07-08 with
scenarios exiting `0` and 95/95 isolated browser shards passing. The required
current mainnet evidence is the operator-facing preflight gate plus its
one-hour soak. This is handoff evidence only; it is not external audit sign-off.

## Scope

Review these surfaces first:

- Runtime frame loop, ingress, and durable commit semantics.
- Entity consensus and account consensus proposer/receiver paths.
- Entity/account tx handlers that mutate balances, pulls, swaps, disputes, or J-batches.
- Storage projection, hydration, WAL replay, canonical hash verification, and restore fail-fast behavior.
- JAdapter RPC path from `processBatch` submission to event normalization and runtime ingestion.
- Cross-jurisdiction delayed-clearing route lifecycle and orderbook cleanup.
- Relay/direct transport trust boundaries, including encrypted-only ingress and hub-only direct endpoints.
- Hub lending pools, loan credit-limit effects, repayment followups, and
  no-liquidity terminal behavior.
- Production deploy, health, and release-gate scripts.
- User-facing Pay, same-account Swap, and Cross-j Swap coverage through the
  shared frontend surfaces and their E2E tests.
- User-facing Lending coverage through the shared frontend surface and E2E
  tests.

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
- Exact bigint fill amounts are settlement truth; uint16 fill ratios are
  one-way hash-ladder/dispute proof projections only.
- Cross-j routes are written by the route lifecycle only; direct account tx helpers cannot bypass filled-route clearing rules.
- Direct same-chain and direct cross-j swaps are the executable swap surface.
  Multihop is a manual route recommendation only unless a future executable
  runner is explicitly reintroduced and tested.
- Lending no-liquidity is an expected terminal product state, not a protocol
  fatal; lending balance divergence or impossible pool/loan accounting is a
  fatal invariant violation.
- Production storage bypass flags and repair shortcuts are unavailable without explicit dev/test intent.

## Required Commands

The reviewer should run these commands from a clean checkout and include exact versions, commit hash, and logs in the report:

```bash
bun run gate:ci
bun run security:contract-governance
bun run security:consensus-hanko
bun run security:failure-taxonomy
bun run security:delivery-boundary
bun run security:canonical-identity
bun run security:canonical-fill
bun run security:swap-cancel-canonical
bun run test:e2e:coverage
bun run test:rpc-settlement
bun run soak:quick
bun run prod:health
```

Before mainnet approval, also run the full release bar:

```bash
bun run gate:release
bun run soak:release
bun run gate:mainnet-preflight
bun run gate:mainnet
```

The soak release command is deliberately long. `gate:mainnet` is the current
operator-facing mainnet preflight with the one-hour soak enabled. These are
operational evidence for restart/load stability, not unit-test substitutes.

## High-Risk Files

- `runtime/runtime.ts`
- `runtime/entity-consensus.ts`
- `runtime/account-consensus.ts`
- `runtime/entity/tx/apply.ts`
- `runtime/entity/tx/j-events.ts`
- `runtime/entity/tx/handlers/account.ts`
- `runtime/entity/tx/handlers/account-cross-j-followups.ts`
- `runtime/account/tx/handlers/pull.ts`
- `runtime/account/tx/handlers/swap-resolve.ts`
- `runtime/cross-jurisdiction.ts`
- `runtime/extensions/cross-j/orderbook.ts`
- `runtime/storage/read.ts`
- `runtime/storage/projections.ts`
- `runtime/storage/canonical-hash.ts`
- `runtime/jadapter/rpc.ts`
- `runtime/jadapter/helpers.ts`
- `runtime/lending.ts`
- `runtime/types/lending.ts`
- `runtime/entity/tx/handlers/lending.ts`
- `runtime/server/lending.ts`
- `runtime/relay/router.ts`
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
- Do not report missing executable multihop swaps as a current implementation
  bug without also noting the current product decision: direct swaps execute;
  multihop is advisory/manual only.
- Do not accept BrowserVM-only evidence for J-layer correctness. BrowserVM is a
  dev/demo simulator for now; the public-testnet gate is RPC/anvil only.

## Known Open Mainnet Blockers

- Signing remains scheduled for a remote signer/HSM boundary; raw runtime
  signing seed material must not be treated as a final real-funds posture.
- The current one-hour mainnet-preflight soak must complete uninterrupted from a
  clean tree.
- Real mainnet RPC endpoints, operator/tower funding, gas policy, incident
  drills, and alert thresholds must be explicit before uncapped launch.
- Independent external audit is required before real user funds, even when all
  internal gates are green.

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

The report is not complete if it does not cover storage restore, J-event
authentication, cross-j route lifecycle, network ingress, and Lending.
