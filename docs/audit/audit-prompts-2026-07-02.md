# xln audit prompts and answers - 2026-07-02

Scope: current dirty checkout of `/Users/zigota/xln` on `main...origin/main`.

Goal: generate 10 high-level expert prompts, sharpen them, then answer them from
the repo. Primary product direction: simplify until the protocol is easy to
audit, deterministic, flexible, and reliable.

## Executive Read

- Overall verdict: the protocol core is serious, not toy code. The strongest
  parts are nonce/hash replay discipline, on-chain `processBatch`, bilateral
  frame verification, storage restore checks, and cross-j route tests.
- Main weakness: auditability. Large files, stale deployment scripts, stale
  README files, and mixed UI/bootstrap/runtime repair paths make it harder to
  know which path is canonical.
- Highest-risk concrete issue: production foundation governance appears
  effectively unreachable without Hardhat impersonation unless a real foundation
  board/signature path is proven.
- Highest-leverage simplification: define one canonical deploy/start/test path,
  archive old scripts/artifacts, and split giant runtime/frontend files around
  state-machine boundaries.
- Confidence: 82%. I inspected contracts, runtime, storage, frontend stores,
  orchestrator, dev scripts, and test gates, but did not perform a full formal
  verification or line-by-line frontend review.

## Top Findings

1. P1 - foundation governance bootstrap is not production-proven.
   Evidence: `EntityProvider` mints foundation tokens to `address(1)`;
   tests impersonate that address to transfer tokens. Production cannot do that.

2. P1 - stale deploy/test surfaces can mislead audits and deployments.
   Evidence: `deploy-base.cjs` deploys `Depository` without `Account` library
   linking and passes a constructor arg to `DeltaTransformer`; other scripts call
   removed functions like `debugBulkFundEntities`.

3. P2 - Hanko comments and actual code disagree.
   Comments describe optimistic nested/entity-reference governance, but code now
   requires EOA voting power alone to meet threshold.

4. P2 - runtime core is architecturally sound but too large to audit quickly.
   `runtime.ts` is 4067 lines, `entity-consensus.ts` 2052,
   `account-consensus.ts` 1427, `cross-jurisdiction.ts` 1195.

5. P2 - frontend has command routing and receipts, but still exposes shallow
   live env views and vault bootstrap repair paths that are not purely UI.

6. P2 - test surface is broad, but the auditability gates are too permissive.
   Frontend file limit is 5000 lines, runtime has no equivalent line budget, and
   determinism static scan covers only selected state-machine files.

## 01 - Contract Correctness

Expert prompt:

> As a protocol smart-contract auditor, verify whether `Depository`, `Account`,
> `EntityProvider`, and `DeltaTransformer` enforce the same authorization,
> nonce, dispute, debt, token-accounting, and batch-size invariants that the
> runtime assumes. Identify any production/deploy mismatch, not just Solidity
> bugs.

Answer:

- Score: 7.5/10.
- The core `Depository`/`Account` path is strong. `processBatch` binds hanko
  signatures to domain, chain id, depository, exact batch calldata, and a
  strictly sequential entity nonce.
- Settlement, C2R, dispute start, cooperative finalize, counter-dispute, and
  debt enforcement have meaningful tests in `jurisdictions/test/Depository.ts`.
- The bigger risk is not an obvious accounting exploit. It is canonical-path
  confusion from stale scripts/artifacts and foundation bootstrap ambiguity.

Evidence:

- `Depository.processBatch`: `jurisdictions/contracts/Depository.sol:226`.
- Batch bounds and flashloan aggregation: `Depository.sol:369`.
- Account settlement/C2R/dispute nonce logic: `jurisdictions/contracts/Account.sol:224`, `323`, `443`.
- Contract tests cover nonces, replay, active dispute blocking, duplicate token
  IDs, batch caps, watchtower, debt FIFO, malformed dispute args, and ERC token
  edge cases: `jurisdictions/test/Depository.ts:352-1907`.

Risks:

- Stale deploy scripts can deploy or test a non-canonical contract stack.
- `EntityProvider` foundation admin path is not production-proven.
- `jurisdictions/README.md` is still a sample Hardhat README, which is bad for
  external audit handoff.

Simplification moves:

- Keep one deploy entrypoint: `jurisdictions/scripts/deploy-stack.cjs`.
- Move obsolete scripts/artifacts to `docs/archive` or delete them after a
  failing-reference check.
- Add a contract-surface test that asserts the deployed ABI does not contain
  old debug/test functions and that `Depository` bytecode is linked.

Required gates:

- `bun run test:contracts:full`.
- A dry-run deploy test on a fresh local chain using only the canonical script.
- ABI allowlist check for production contracts.

## 02 - Governance and Hanko

Expert prompt:

> As a governance/cryptography auditor, evaluate whether Hanko authorization and
> entity governance are simple, explicit, and production-recoverable. Check
> nested entity behavior, EOA threshold semantics, foundation bootstrap, action
> nonces, and comments against code.

Answer:

- Score: 6/10.
- Hanko has good defensive changes: low-S ECDSA, at least one real EOA signer,
  invalid signatures cannot shift signer slots, and EOA voting power must meet
  threshold.
- But the code comments still describe "assume YES" nested governance as
  intended behavior while the implementation rejects entity-reference-only
  threshold satisfaction.
- Foundation governance is the main red flag: entity #1 uses
  `keccak256("FOUNDATION_INITIAL_QUORUM")`, tokens are minted to `address(1)`,
  and tests need Hardhat impersonation to transfer them.

Evidence:

- Foundation setup: `jurisdictions/contracts/EntityProvider.sol:103-128`.
- `onlyFoundation`: `EntityProvider.sol:135`.
- Test impersonation: `jurisdictions/test/EntityProvider.test.cjs:19-42`.
- Hanko threshold code: `EntityProvider.sol:760-850`.
- Entity action nonces: `EntityProvider.sol:1094-1180`.

Risks:

- Foundation-only functions may be effectively locked in production.
- External auditors will flag the Hanko comment/code mismatch as ambiguity.
- `recoverEntity` and `verifyHankoSignature` are two authorization languages:
  one board-hash/recover path and one packed Hanko path. That doubles audit
  burden.

Simplification moves:

- Decide one rule: either entity references are advisory only, or nested entity
  voting is real. Then delete contradictory comments and tests.
- Bootstrap foundation with a real Board whose private keys exist, or remove
  foundation-only mutation paths from production.
- Add a production-style foundation test with no impersonation.

Required gates:

- Hanko vectors: EOA-only threshold pass, nested-only threshold fail/pass
  according to chosen spec, circular reference rejection/pass according to spec.
- Foundation transfer/name/admin test with real signatures only.

## 03 - RJEA Determinism

Expert prompt:

> As a deterministic distributed-systems auditor, prove that Runtime/Entity/
> Account/Jurisdiction frame application is a pure function of previous env and
> inputs. Identify every wall-clock/random/timer source and classify it as
> protocol state, ingress, UI, or infrastructure.

Answer:

- Score: 8/10.
- Core state application is largely deterministic. `process()` assigns one frame
  timestamp before `applyRuntimeInput`, and entity/account consensus uses that
  env timestamp for hashes and WAL.
- Static guard exists for selected state-machine files and blocks `Date.now`,
  `Math.random`, timers, and random bytes in the most critical directories.
- The biggest questionable path is `buildCrossJurisdictionSwapSubmission`,
  which defaults `orderId` to wall clock plus random bytes. This is acceptable
  only if treated as external ingress, not protocol state-machine logic.

Evidence:

- `applyRuntimeInput`: `runtime/runtime.ts:1573`.
- Timestamp comment: `runtime/runtime.ts:1714`.
- Determinism guard: `runtime/scripts/check-determinism.ts`.
- Cross-j default random order id:
  `runtime/runtime-jurisdiction-api.ts:83-90`.

Risks:

- Helper APIs that both build inputs and generate IDs blur the line between UI
  ingress and deterministic protocol.
- Static determinism guard scans selected files, not all modules reachable from
  state-machine handlers.
- The browser `utils.hash/createHash` shim is non-cryptographic. It does not
  appear to drive frame hashes now, but it is a future footgun.

Simplification moves:

- Require caller-provided `orderId` for all consensus-affecting route creation,
  or derive it from canonical deterministic route fields.
- Rename/remove non-crypto hash utilities so protocol code cannot import them.
- Expand determinism static scan to all transitive state-machine modules.

Required gates:

- `bun run check:determinism`.
- Deterministic replay for cross-j route creation with identical inputs.
- Static import rule: protocol modules may import only approved crypto hash
  helpers.

## 04 - Entity Consensus

Expert prompt:

> As a BFT/state-machine replication reviewer, check whether a malicious or
> lagging entity validator can make peers sign an invalid state, accept a
> proposed `newState` without replay, duplicate outputs, or fork frame hashes.

Answer:

- Score: 8/10.
- Validators replay proposed frames locally and compare recomputed hashes. They
  do not trust `proposedFrame.newState` as the source of truth.
- Commit catch-up also replays the frame locally if the validator missed the
  proposal. This is the right shape.
- Single-signer mode still creates hash-linked frames and signs hashes, which is
  good for audit consistency.

Evidence:

- Proposal verification/replay: `runtime/entity-consensus.ts:879-925`.
- Commit replay instead of trusting transported state:
  `runtime/entity-consensus.ts:784-827`.
- Single-signer hash-linked frame path:
  `runtime/entity-consensus.ts:1129-1188`.
- Entity tx dispatch table: `runtime/entity/tx/apply.ts:193-276`.

Risks:

- `entity-consensus.ts` is 2052 lines and mixes consensus, account proposal
  scheduling, orderbook, cross-j lifecycle, outputs, and logs.
- Error taxonomy is partly prefix/string based. `applyEntityTx` catches handler
  errors, but `applyEntityFrame` later fails frames on `skippedError`; the
  behavior is fail-fast but difficult to reason about.

Simplification moves:

- Split entity consensus into: proposal/commit verification, frame application,
  account scheduler, orderbook/cross-j scheduler, output planner.
- Replace string-prefix error classification with typed protocol error codes.
- Keep `applyEntityFrame` as a small pure replay kernel with no orchestration.

Required gates:

- Byzantine proposal tests: wrong hash, wrong `hashesToSign`, missing precommit,
  changed tx order, duplicate outputs.
- Replay equivalence tests between proposer and validator paths.

## 05 - Bilateral Account Consensus

Expert prompt:

> As a bilateral-channel protocol auditor, verify that account frames, ACKs,
> dispute seals, j-event observations, and replay rules prevent stale state,
> state injection, duplicated commits, and ACK poisoning while tolerating
> at-least-once delivery.

Answer:

- Score: 8.5/10.
- This is one of the stronger parts. ACKs verify Hanko over the pending frame
  hash, re-execute txs on real state, then commit. New frames verify sender
  Hanko, prev hash, height/sequence, tiebreaker, offdelta/bilateral fields, and
  recomputed frame hash.
- Dispute proof hashes are treated as separate signed evidence, not confused
  with ACKs.
- Replay and duplicate handling exists around pending frames and stale frames.

Evidence:

- ACK pending-frame verification: `runtime/account-consensus.ts:374-523`.
- New frame verification/replay/hash compare: `account-consensus.ts:732-1026`.
- Dispute seal commentary and verification: `account-consensus.ts:97-147`.
- Storage of last outbound ACK is covered:
  `runtime/__tests__/audit-failfast-regressions.test.ts:3206`.

Risks:

- `account-consensus.ts` is 1427 lines and still carries many logs and
  branching modes.
- The function `handleAccountInput` is doing too much for one review unit.
- A future maintainer can break account invariants by touching UI capacity math;
  current `deriveDelta` guard helps but only scans selected surfaces.

Simplification moves:

- Extract ACK commit, incoming frame validation, simultaneous proposal
  resolution, and dispute seal logic into separate pure modules.
- Keep one public account consensus function that just orchestrates those pure
  validators.
- Strengthen property tests around duplex replay and simultaneous proposals.

Required gates:

- Account frame integrity tests.
- Replay/duplicate/stale ACK tests.
- Property tests that mutate tx order, offdelta, prev hash, and dispute proof
  independently.

## 06 - Cross-Jurisdiction Swaps

Expert prompt:

> As a cross-chain settlement/orderbook auditor, verify whether the cross-j
> route lifecycle is a monotonic finite-state machine with canonical route
> hashes, exact fill amounts, safe partial/cancel semantics, dispute salvage,
> and no forged receipt or stale fill path.

Answer:

- Score: 7/10.
- The design is advanced and has the right primitives: status transition table,
  canonical route hash, stack/domain binding, exact fill numerator/denominator,
  uint16 projection, quantization dust limits, fill sequence monotonicity, and
  dispute/salvage tests.
- The complexity is high. This is the part most likely to hide bugs not because
  the code is sloppy, but because the lifecycle has many states and sidecars.
- Strong direction: keep the finite-state machine as data, not hidden across
  handlers.

Evidence:

- Status table and transition guard: `runtime/cross-jurisdiction.ts:47-118`.
- Fill progress validation: `cross-jurisdiction.ts:260-389`.
- Deterministic private seed requirement:
  `cross-jurisdiction.ts:427-447`.
- Security tests for forged receipts, committed fill progress, dispute salvage:
  `runtime/__tests__/cross-jurisdiction-security.test.ts`.
- Broad cross-j swap tests: `runtime/__tests__/cross-jurisdiction-swap.test.ts`.

Risks:

- Route lifecycle spans `cross-jurisdiction.ts`,
  `cross-jurisdiction-orderbook.ts`, entity consensus, account txs, and j-events.
- `status` rank and allowed transitions are good, but not yet a standalone spec
  that external auditors can mechanically compare to code.
- Random/default `orderId` in the builder API can create nondeterministic ingress
  unless explicitly treated as UI/external.

Simplification moves:

- Make a single cross-j FSM table document and generate transition tests from it.
- Create one pure reducer per transition family: admit, fill, cancel, clear,
  claim, salvage, expire.
- Forbid implicit order id generation in protocol-facing builders.

Required gates:

- Transition matrix tests generated from the table.
- Forged receipt and same-seq divergent fill tests.
- Partial-fill exact amount and dust-bound property tests.
- Browser e2e for full, partial, cancel, disputed, and expired cross-j flows.

## 07 - Storage, Recovery, Watchtower, Radapter

Expert prompt:

> As a durability/recovery auditor, verify that runtime state is persisted,
> restored, queried, and served over radapter without schema drift, torn
> snapshots, stale frame DB, hidden mutation, or recovery evidence loss.

Answer:

- Score: 8/10.
- Storage has a serious model: live docs, frame DB, snapshots, diffs, merkle
  state roots, optional canonical state hash, and fail-closed restore checks.
- There are tests for missing frame DB, missing replay diffs, torn snapshots, and
  canonical mismatch.
- The main weakness is operational: canonical hash audit is configurable/off by
  default unless explicitly enabled, and field drift requires discipline across
  projection, hydration, and hashing.

Evidence:

- Storage documentation notes schema drift risk: `docs/runtime/storage.md`.
- Canonical hash implementation: `runtime/storage/canonical-hash.ts`.
- Save path append invariant and frame hash: `runtime/storage/index.ts:342-440`.
- Restore canonical mismatch check: `runtime/runtime.ts:3375-3395`.
- Storage fail-closed tests:
  `runtime/__tests__/storage-frame-journal-retention.test.ts:289`, `760`.

Risks:

- Projection/hydration/canonical hash must be updated together for every state
  field. That is easy to forget in a fast-moving protocol.
- Read/query layers are now important protocol infrastructure, not just UI.
- Recovery/watchtower tests are broad, but a field omission can still pass if no
  scenario touches that field.

Simplification moves:

- Add a "state field registry" or generated projection coverage test.
- Enable canonical audit in release/soak gates even if it stays off for normal
  local dev performance.
- Make radapter read models explicitly read-only and schema-versioned.

Required gates:

- `storage-canonical-hash`, `storage-crash-recovery`,
  `storage-frame-journal-retention`.
- Watchtower last-resort and restart-resilience tests.
- Radapter inspect/admin permission tests.

## 08 - Frontend Trust Boundary

Expert prompt:

> As a frontend/security/product auditor, determine whether the Svelte app is a
> command-only projection layer or whether it can mutate protocol state directly.
> Check runtime adapter permissions, debug surfaces, live env references, vault
> bootstrap repair code, and UI math duplication.

Answer:

- Score: 6.5/10.
- Good: there is a runtime controller, remote/embedded adapter abstraction,
  command receipts, projection refresh, runtime id mismatch checks, and local
  debug surface limited to localhost.
- Weak: view envs are shallow copies with a hidden live env pointer. Several
  frontend paths unwrap the live env and call runtime functions directly for
  embedded mode.
- Vault/bootstrap code does more than UI: it restores envs, imports
  jurisdictions, imports replicas, starts loops, starts P2P, and repairs live
  J-adapters.

Evidence:

- Hidden live env pointer: `frontend/src/lib/utils/liveRuntimeEnv.ts`.
- Runtime controller send path: `frontend/src/lib/stores/runtimeControllerStore.ts:189`.
- Command receipts: `frontend/src/lib/stores/runtimeCommandBus.ts`.
- Local debug gating: `frontend/src/lib/utils/debugSurface.ts`.
- Vault runtime repair/import path:
  `frontend/src/lib/stores/vaultStore.ts:2160-2385`.

Risks:

- UI components can accidentally depend on live env mutability.
- Bootstrap/repair logic in frontend is harder to test as protocol infra.
- Stale `/view` README describes files/layouts that no longer match the repo.

Simplification moves:

- Make UI consume immutable projections by default; expose live env only behind a
  dev/test capability.
- Move bootstrap/repair orchestration into runtime adapter/server APIs, leaving
  frontend as command sender and projection viewer.
- Lower frontend file-size guard from 5000 lines and split `EntityPanelTabs`,
  `Graph3DPanel`, `vaultStore`, and `xlnStore`.

Required gates:

- Browser console smoke: `window.__xln.adapter.status()`,
  `window.__xln.commands.latest`, no production debug surface off localhost.
- E2E for remote inspect token rejecting writes.
- Unit tests for runtime id mismatch and command receipt transitions.

## 09 - Orchestrator, Dev, Deploy, Ops

Expert prompt:

> As an SRE/release engineer, verify whether one command starts the same system
> that tests and production deploy use. Check reset safety, port layout, child
> process lifecycle, health redaction, stale process reaping, disk gates, and
> contract deployment canonicality.

Answer:

- Score: 6.5/10.
- Orchestrator has many good production features: reset guard, health model,
  redaction, disk preflight, managed process leases, child restart/reap, runtime
  import readiness, metrics, graceful shutdown.
- Dev startup is aggressive: `clean-slate.sh` kills listeners/processes and
  removes `db`, `db-tmp`, logs, and pids. Fine for local, dangerous if confused
  with prod.
- Deploy/start paths are not simple enough. There are multiple deploy scripts,
  some stale, and package scripts still include direct production deploy/reset
  commands.

Evidence:

- Dev stack: `scripts/dev/run-dev.sh`.
- Destructive local clean slate: `scripts/dev/clean-slate.sh`.
- Port layout: `scripts/lib/port-layout.sh`.
- Reset guard: `runtime/orchestrator/reset-guard.ts`.
- Orchestrator reset flow: `runtime/orchestrator/orchestrator.ts:2148-2284`.
- Health/runtime import endpoints:
  `runtime/orchestrator/orchestrator.ts:2405-2475`.

Risks:

- Stale deploy scripts make it unclear which production path is authoritative.
- `deploy:prod:*` package scripts are powerful and need explicit runbook
  alignment.
- Orchestrator is one large file with many responsibilities.

Simplification moves:

- Create a single `docs/deployment/canonical-stack.md` and make scripts point to
  it.
- Make destructive commands require explicit env confirmation even in shell
  scripts.
- Split orchestrator into reset, child lifecycle, HTTP API, health, and relay
  modules with narrow interfaces.

Required gates:

- `prod-startup-wiring.test.ts`.
- `orchestrator-reset-guard.test.ts`.
- `prod:bootstrap:soundcheck`.
- Local dry-run that starts, health-checks, resets, and shuts down cleanly.

## 10 - Testing Strategy

Expert prompt:

> As a test architect, evaluate whether the repo has a risk-based L1/L2/L3
> ladder for contracts, runtime state machines, frontend UI, recovery, and
> production ops. Identify gaps where broad e2e tests compensate for missing
> narrow invariants.

Answer:

- Score: 7.5/10.
- The repo has unusually broad tests: contract tests, runtime unit tests,
  scenario runner, determinism checks, isolated Playwright shards, release gate,
  soak gate, radapter benchmarks, storage crash tests, and watchtower tests.
- The ladder exists in spirit but not always in command ergonomics. `bun run
  check` is static/type/frontend only; it does not run contract or runtime unit
  tests.
- Some gates are too permissive for auditability: frontend source limit is 5000
  lines, and runtime has no equivalent file-size limit.

Evidence:

- `bun run check`: `package.json:132-141`.
- Fast suite: `runtime/scripts/run-all-tests-fast.ts`.
- Fast e2e target list: `runtime/scripts/run-e2e-fast.ts`.
- Release gate: `runtime/scripts/run-release-gate.ts`.
- Determinism guard: `runtime/scripts/check-determinism.ts`.
- Manual delta guard: `runtime/scripts/check-no-manual-delta-math.ts`.

Risks:

- Developers can pass `bun run check` while core runtime unit tests fail.
- Large e2e suites are expensive and can hide missing L1 invariants.
- Some old scripts and artifacts are not covered by staleness/dead-entrypoint
  checks.

Simplification moves:

- Define named gates:
  - L1: affected unit/property tests.
  - L2: one targeted scenario/e2e flow.
  - L3: `check`, contracts, release/soak profile as appropriate.
- Add stale-entrypoint checks for deploy scripts and old ABI functions.
- Add runtime file-size/module boundary guard and lower frontend limit.

Required gates:

- Every PR: `bun run check` plus changed-area L1 tests.
- Contract changes: `bun run test:contracts:full`.
- Runtime consensus changes: determinism + affected runtime unit + one scenario.
- Frontend command/projection changes: targeted frontend unit + one Playwright
  e2e with browser console assertions.

## Priority Plan

P0/P1 first:

1. Prove or replace foundation governance bootstrap without impersonation.
2. Delete/archive stale deploy scripts and generated stale artifacts.
3. Make Hanko nested-governance semantics match comments, docs, and tests.
4. Make canonical deploy/test path the only documented path.

P2 next:

1. Split `runtime.ts`, `entity-consensus.ts`, `account-consensus.ts`, and
   `cross-jurisdiction.ts` by replay kernel vs orchestration.
2. Move frontend bootstrap/repair actions behind runtime adapter APIs.
3. Add projection/hydration/canonical-hash coverage checks for every state field.
4. Lower file-size limits and add runtime-size/auditability guard.

P3 polish:

1. Replace stale READMEs in `jurisdictions` and `frontend/src/lib/view`.
2. Rename/remove non-crypto hash helpers.
3. Generate cross-j FSM tests from a table.
4. Keep a small audit map: canonical entrypoints, critical invariants, and gates.

## Final Judgment

xln has a real protocol core. The next level is not more features. It is
removing ambiguity around which paths are canonical, shrinking the state-machine
review units, and making production bootstrap/deploy/test mechanically
provable.

The target architecture should feel like this:

- contracts: one deployable stack, no stale ABI ghosts;
- runtime: pure reducers plus explicit side-effect boundary;
- frontend: immutable projection plus command receipts;
- orchestrator: one canonical stack controller with guarded reset;
- tests: narrow invariants first, one targeted flow second, broad gate third.
