# xln TODO

Last verified against code: 2026-07-10.

This is the only live TODO/NEXT file. Closed work is intentionally absent;
history remains in git. Every item below is still open or intentionally heavy.

## P0 — fintech-mainnet blockers

### 0. Bind bilateral account identity into every signed account frame

- Evidence: `createFrameHash` commits transition fields and deltas but not the
  two entity ids or an account/domain tag. `watchSeed` and the dispute seal do
  bind the account, but both are optional on incoming frame envelopes.
- Reproduced on current HEAD: a real A→B `set_credit_limit` frame and A hanko
  were replayed into the empty A↔C account after stripping only the optional
  `watchSeed` and dispute-seal fields; `applyAccountInput` accepted height 1 and
  granted C the credit intended for B.
- Risk: a captured genesis frame can authorize bilateral money state in another
  account with the same signer and left/right orientation.
- Acceptance: obtain explicit consensus approval; version the account-frame
  domain over canonical left/right entity ids plus chain/depository context;
  make account-bound envelope evidence non-strippable; reject A↔B frames on
  A↔C at L1/L2; publish migration/replay/golden vectors before activation.

### 1. Move signing behind a remote signer/HSM boundary

- Status: deferred by explicit hardening constraint; do not change seed,
  signing, HSM, remote-signer, or key-rotation code in routine cleanup.
- Verified partial: canonical checkpoints and plaintext recovery bundles omit
  `runtimeSeed`; runtime-adapter auth defaults to a separate
  `XLN_RADAPTER_AUTH_SEED`. The opt-in
  `XLN_RADAPTER_ALLOW_RUNTIME_SEED_AUTH` compatibility path still couples
  adapter authority to the runtime master seed and must not exist in the
  mainnet boundary.
- Evidence: browser vault runtimes still contain mnemonic/seed material and
  derive/register signer keys in `frontend/src/lib/stores/vaultStore.ts`;
  `signEntityHashes` and `signAccountFrame` still derive private keys from
  `env.runtimeSeed`. Production signing therefore has no demonstrated hardware
  custody boundary.
- Risk: browser or host compromise can expose long-lived signing material;
  rotation and incident containment are not operationally proven.
- Acceptance: introduce one `SignerProvider` boundary for account/entity
  hashes; persist signed outputs before commit; replay consumes persisted
  signatures and never calls the signer; raw production keys never enter app
  memory; signer identity is attested; threshold/role policy, rotation,
  revocation, backup, recovery, audit logs, and fail-closed outage drills pass.

### 2. Produce release evidence from one frozen candidate

- Evidence missing: a clean uninterrupted `bun run gate:mainnet`, the one-hour
  capped-testnet soak, the one-tower/three-hub canary, browser/F12 drills, and a
  rollback drill from the exact same commit.
- Risk: green component suites do not prove long-running topology, restart,
  RPC, persistence, or operator behavior.
- Acceptance: every artifact required by
  `docs/mainnet-acceptance-gate.md` is attached to one clean commit; any fix
  restarts the evidence loop.

### 3. Complete real mainnet operations planning

- Evidence missing: final chain/RPC providers, funded operator and contract
  roles, alerts, secret ownership, gas policy, incident response, backup,
  rollback, and enforceable value caps.
- Risk: correct code can still lose funds through ambiguous operational
  authority or an untested recovery procedure.
- Acceptance: `docs/deployment/ops-runbook.md` is exercised on the intended
  topology with named owners, monitored SLOs, least privilege, rollback, and
  recovery evidence.

### 4. External audit handoff and independent sign-off

- Evidence: internal review is mapped in `auditormemo.md`; independent sign-off
  for the frozen release candidate is absent.
- Risk: correlated implementation and review assumptions remain unchecked.
- Acceptance: auditors receive reproducible source/test evidence, all critical
  and high findings are fixed and retested, residual risks have explicit
  owners, and the audited commit matches the release candidate.

## P1 — protocol, runtime, and operations

### 1. Peer State Refresh (PSR)

- Implement the authenticated peer/hub refresh flow in
  `docs/recovery-watchtower-protocol.md`.
- Acceptance: a wiped client recovers the highest valid state from honest
  peers when towers are unavailable; stale, equivocal, malformed, and replayed
  responses fail closed with deterministic selection and browser E2E coverage.

### 2. Recovery coverage and receipts

- Surface local backup, tower backup, delayed last-resort, and PSR coverage per
  runtime/account, including last successful height and typed failure.
- Acceptance: users and operators can prove which state is recoverable, from
  where, at what height, and why any source is degraded; no recovery failure
  silently opens fresh state.

### 3. Finish the typed failure taxonomy

- Current partial: recovery, runtime import, health, proxy, faucet, bootstrap,
  market-maker, settlement, and delivery paths expose typed failure metadata;
  `bun run security:failure-taxonomy` guards the current boundary.
- Remaining risk: peripheral transport/bootstrap/ops callers still infer
  retry/fatal behavior from strings or raw errors.
- Acceptance: `Contradiction`, `ExpectedEmpty`, and `TransientRace` drive one
  bounded policy across health and orchestration; no consensus hot path is
  weakened to achieve taxonomy coverage.

### 4. Finish one delivery boundary

- Current partial: relay/direct/local paths share `DeliveryResult`, bounded
  pending queues, terminal/retry metadata, and scan coverage through
  `bun run security:delivery-boundary`.
- Remaining risk: duplicated lifecycle decisions can diverge under reconnect,
  queue expiry, or relay/direct races.
- Acceptance: one boundary owns enqueue, delivery, ACK, retry, TTL, drop, and
  diagnostics; direct transport is only a fast path over identical semantics.

### 5. Finish canonical identity cleanup

- Current partial: stack identity is `stack:<chainId>:<depository>` and the
  principal hub/MM/browser paths reject display-name identity; guarded by
  `bun run security:canonical-identity`.
- Remaining risk: legacy fixtures and peripheral APIs still carry optional
  name-based or incomplete identity fields.
- Acceptance: jurisdiction/entity/account matching is canonical everywhere;
  display labels cannot affect routing, readiness, funding, restore, or tests.

### 6. Finish exact fill semantics and bounded cross-j state

- Current partial: exact bigint numerator/denominator are authoritative and
  uint16 is proof projection only; deferred fill ACKs are capped at 1024 and
  TTL-marked; guarded by `bun run security:canonical-fill`.
- Remaining risk: legacy fill fields still exist, and route/admission/swap
  records can remain in deterministic state after closing; see HEAVY item 3.
- Acceptance: all settlement economics use exact amounts, legacy ratio
  fallback is removed through a versioned migration, dust rules are explicit,
  and every evidence/history collection has a deterministic bound.

### 7. Model bootstrap as an explicit state machine

- Required phases: P2P, relay, hubs, custody, same-j MM, cross-j MM,
  watchtower, and health.
- Acceptance: actions are impossible before their barrier; health returns the
  exact blocked phase and typed dependency; restart/resume tests cover every
  transition without wall-clock-dependent RJEA behavior.

### 8. Build a verified cold-system fixture

- Scope: chains, contracts, hub mesh, custody, same/cross-j books, watchtower,
  and runtime import manifest.
- Acceptance: fast browser/radapter tests hydrate one versioned, hash-checked
  fixture without weakening production readiness or sharing mutable state.

### 9. Tighten orchestrator blast radius

- Risk: ancillary child failure can obscure the health endpoint needed to
  diagnose the system; protocol contradictions must still halt loudly.
- Acceptance: faucet/demo/MM/watchtower degradation stays queryable and typed;
  custody or consensus contradiction remains fatal; kill/restart matrix passes.

### 10. Add executable settlement conservation proofs

- Cover both legs of `pull_lock -> resolve -> on-chain release`, including
  debt, collateral, dispute start, and `_disputeFinalizeInternal`.
- Acceptance: property/adversarial tests prove conservation and authorization
  for success, retry, replay, partial fill, and abort; external auditors can
  reproduce every invariant.

### 11. Validate economics and scale

- Document fee design, collateral ratios, MM incentives, griefing costs,
  queue/state bounds, and intended value/concurrency limits.
- Acceptance: contention benchmarks and adversarial cost models justify
  enforced limits; no mainnet limit is based on an unmeasured assumption.

### 12. Define the supported-token boundary

- Either prove multi-token collateral, settlement, recovery, dispute, and UI
  flows end to end, or enforce and label a single-token release boundary.
- Acceptance: contracts, runtime admission, API, health, and UI reject any
  unsupported token consistently and loudly.

### 13. Add a durable storage writer fencing token

- Current partial: `saveEnvToDB` wraps the full head-read/write path in an
  exclusive `wx` namespace lock and rejects live-PID owners. Concurrent stale
  takeover is now serialized by a separate exclusive recovery claim, and both
  lock releases verify the acquired owner token. A 20-process regression proves
  that exactly one dead-lock reclaimer enters the write section.
- Remaining evidence: `StorageHead` does not carry a durable fencing token. A
  process killed during the short recovery-claim window fails closed and needs
  explicit operator cleanup; PID reuse and current/history parity under killed
  writers are not yet covered.
- Risk: filesystem ownership prevents the reproduced local split-writer race,
  but it is not a storage-enforced monotonic lease across namespace copies,
  process crashes, or operational recovery mistakes.
- Acceptance: every append owns a monotonic durable fencing token recorded in
  the authoritative head and checked in the same commit path; stale takeover
  cannot remove a newer lease; adversarial multi-process tests cover concurrent
  takeover, killed writers, long writes, PID reuse, and current/history parity.

## HEAVY TODO — separate design/approval required

### 1. Prove validate/commit equivalence

- Evidence: account frames validate on a clone with `isValidation=true` and
  commit on the live replica with `isValidation=false`; `j_event_claim`
  finalization is commit-only.
- Risk: a future handler can mutate or branch differently after a frame has
  already passed validation.
- Acceptance: define the intended phase contract, add state/output equivalence
  tests for every account tx, remove accidental phase branching, and migrate
  only with explicit consensus approval and replay vectors.

### 2. Canonicalize AccountState/AccountReplica clone discipline

- Evidence: `runtime/state-helpers.ts` uses `structuredClone` plus large manual
  fallbacks; replica proposal/locked-frame state and outputs do not all share
  one explicit ownership rule.
- Risk: aliasing can let validation or proposal work mutate committed state;
  broad clone changes can also alter consensus behavior and performance.
- Acceptance: document ownership per field, add mutation/alias property tests,
  choose one canonical clone/snapshot boundary, benchmark it, and migrate with
  consensus approval plus historical replay.

### 3. Bound cross-j admission, route, and swap history

- Evidence: pending cross-j fill ACKs are capped, but
  `crossJurisdictionBookAdmissions` and `crossJurisdictionSwaps` close records
  without a general deterministic deletion/compaction bound.
- Risk: long-lived entities can grow consensus state and snapshots without
  limit; naive deletion can destroy replay/dispute evidence.
- Acceptance: specify evidence retention by lifecycle and dispute horizon,
  introduce deterministic compaction/version migration, prove late replay and
  dispute safety, and add soak tests that demonstrate a hard state-size bound.

### 4. Introduce canonical binary encoding and versioned hashes

- Evidence: protocol/storage hashes still depend on the current canonical JSON
  model and BigInt conventions. Fixed account/entity frame vectors exist, but
  WAL checkpoint/recovery, storage-head/frame, proof, and cross-language vectors
  are not frozen as one versioned corpus.
- Risk: cross-language ambiguity and future serializer drift; direct encoding
  replacement would invalidate proofs, journals, and fixtures.
- Acceptance: publish golden vectors, domain/version tags, independent
  implementations, dual-read/dual-hash migration, rollback plan, and replay of
  historical state before consensus activation.

### 5. Split AccountState and extract consensus extensions

- Scope: separate canonical state, computed/cache state, proposal state, and
  extension reducers; shrink large consensus modules without wrapper layers.
- Money-core boundary: orderbook, cross-j, and lending mostly enqueue
  `AccountTx`, while J-event reconciliation legitimately writes canonical
  `ondelta/collateral`; no module/type boundary prevents a future feature from
  mutating those fields directly.
- Risk: a broad structural rewrite can change serialization, transition order,
  or mutation ownership while appearing type-safe.
- Acceptance: dependency/ownership map, characterization tests, measured LOC
  and audit-surface reduction, compile-time imports that confine money mutation
  to AccountTx/J-event reducers, adversarial conservation tests, small
  replay-equivalent migrations, and no special/test-only execution path.

### 6. Add formal state-machine models

- Model bilateral proposal/ACK/freeze, simultaneous proposals, dropped and
  duplicate ACKs, recovery, and cross-j lifecycle in TLA+/PlusCal or equivalent.
- Acceptance: model-check stated safety/liveness properties and connect every
  counterexample class to an executable regression test.

### 7. Contract and deployment surface cleanup

- Evidence: dead or stale contract sources/interfaces remain (`ECDSA.sol`,
  `IDepository.sol`, `IDeltaTransformer.sol`, `Token.sol`, `console.sol`),
  `IEntityProvider` is not the canonical deployed interface,
  `Account.verifyFinalDisputeProofHanko` appears unused, and parallel deploy
  scripts retain overlapping stack logic.
- Additional evidence: `createSettlementHashWithNonce` hardcodes an empty
  `forgiveDebtsInTokenIds` projection and should remain fail-closed until the
  intended hash boundary is specified.
- Risk: deleting or changing these paths can alter ABI, bytecode, proof hashes,
  deployment addresses, or external tooling.
- Acceptance: obtain explicit contract approval; prove import/call graph and
  ABI compatibility; add golden hash/deploy vectors; remove only confirmed
  dead surfaces; leave one canonical deploy/verification path.

### 8. Expand multi-validator and jurisdiction adversarial coverage

- Evidence: restore now preserves signer/proposer metadata and fails closed
  when multi-validator live metadata is missing; Hanko separately enforces EOA
  and total voting power. Full threshold/rotation/restore/dispute matrices are
  not yet demonstrated.
- Risk: quorum edge cases can pass unit thresholds but fail across restart,
  proposer rotation, duplicate signatures, or on-chain verification.
- Acceptance: executable N-of-M vectors cover proposer change, restore,
  duplicate/unknown signers, reordered signatures, offline minorities, and
  offchain/onchain parity. Any semantic change requires consensus/crypto/
  contract approval.

### 9. Complete the TypeScript 7 toolchain migration

- Current partial: runtime typecheck uses pinned `@typescript/native`; Svelte,
  ESLint, Hardhat, TypeChain, and ts-node still require compatibility tooling.
- Acceptance: one supported compiler/toolchain passes runtime, frontend,
  contracts, lint, editors, and CI with no compatibility alias.

## P2 — product/UI after mainnet blockers

1. Finish the lending lifecycle in `docs/lend.md`; keep it outside the release
   boundary until runtime, contracts, and browser E2E are complete.
2. Make custody balance, auto-fees, settlement modes, routing, J-events,
   disputes, and recovery receipts coherent in the common app UI.
3. Maintain curated desktop/mobile screenshot and operator-story evidence for
   onboarding, recovery, payments, swaps, disputes, health, remote runtimes,
   and time travel.
4. Finish the AI court app only after protocol/admin gates are green; it is not
   a fintech-mainnet blocker.

## Auxiliary local AI work

- Finish the GPT-OSS 120B MLX download at
  `~/models/gpt-oss-120b-heretic-mlx`.
- Install `piper` for local `/api/synthesize` voice output.
- Fix the green visual speech indicator in `/ai`.
