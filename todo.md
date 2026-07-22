# xln mainnet release TODO

This is the **only live TODO/NEXT file**. Every audit item is tracked here.
An audit claim is not accepted until reproduced against the current candidate.

## Non-negotiable architecture

- One current implementation, one persisted format, one version. No legacy
  branches, V3, dual-read/write, migration layers, or compatibility zoo. This
  testnet-to-mainnet deployment uses a fresh reset.
- Runtime is the policy-enforcement boundary. Do not move policy into an HSM.
  Entity multi-signers provide threshold signing; Runtime signers are derived
  immediately from the seed when the Runtime is created.
- Recovery trust order: operator backups, then watchtowers, then hubs. Peer
  state is not a required source of truth or an automatic recovery dependency.
- J/E/A state transitions remain deterministic and fail-fast. WAL commit
  precedes outbox dispatch. Never swallow errors.
- No frozen-core changes without the owner's interactive approval. Never run
  `bun run frozen-core:approve`.

## P0 — cross-j atomic opening protocol

### Protocol fixed by owner

- [x] M1 User -> Hub: send only an unsigned, non-spendable `cross_j_intent`.
  No source Account proposal, source pull, hold, Hanko/financial signature, or
  authority for the Hub to debit the User.
- [x] M2 Hub: construct one hash ladder and two complete Hub-signed Account
  proposals in one Runtime frame and one durable envelope. The source proposal
  already contains the source `pull_lock + swap_offer`; the target proposal
  contains the target pull. Neither proposal is committed or enforceable by the
  Hub until the User ACKs it.
- [x] M3 User Runtime: prepare both signed Hub Account proposals on scratch
  state without creating Entity frames; validate both Account signatures plus
  cohort, route hash, entities, assets, amounts, ladder roots, pull IDs and
  deadlines; only then atomically create two sibling Entity frames and two
  Account ACKs. Any mismatch drops only this pair, emits a security alert and
  leaves all unrelated Runtime inputs running normally.
- [x] M4 Hub Runtime: synchronously prepare both User-signed ACKs on scratch
  state, match them, and atomically commit both sibling Entity frames. A
  mismatch drops only this pair and alerts. A valid commit materializes the
  source offer in the orderbook and may match immediately. There is no final
  fourth message or ACK back to the User.
- [x] Source and target entities are always siblings in the same Runtime. Do
  not design a distributed transaction between two Hub Runtimes.
- [x] Keep partial-fill hash-ladder semantics. Source reveal deadline is shorter
  than target by dispute delay plus safety margin.
- [x] Remove `CrossJurisdictionBookAdmissionReceipt`, `targetReceipt`, receipt
  pairing and receipt-driven source-pull admission. Transport-level reliable
  delivery receipts are unrelated and remain transport metadata.
- [x] Store/retry the whole cross-j envelope as one unit. No automatic retry is
  required when a peer is offline; an operator may manually retry the intact
  envelope when it returns.

### Proof before implementation

- [x] L1: M1 produces only intent and cannot create/sign/reserve a source pull.
- [x] L1: M2 contains exactly two Hub-signed ready Account proposals in one
  envelope: source pull+offer and target pull; neither is enforceable without
  the matching User ACK.
- [x] L1: corrupt each binding field independently; M3 and M4 leave both
  siblings byte-identical and emit no Entity frame/ACK.
- [x] L1: valid M3 creates exactly two sibling Entity frames and one outbound
  envelope containing exactly the two Account ACKs.
- [x] L1: valid M4 creates exactly two Hub sibling Entity frames in one Runtime
  frame, commits the order, and emits no fourth protocol message.
- [x] L1: a Hub-only source proposal cannot be used in dispute/settlement or
  resolve the source pull before the exact User ACK/Hanko is committed.
- [x] L1: replay/idempotency, whole-envelope manual retry, WAL/restart recovery,
  and no `targetReceipt` in protocol state or persisted records.
- [ ] L2: exact cross-j isolated flow, packet loss/reorder, partial fill, cancel,
  dispute and restart scenarios.
- [ ] L3: full cross-j/security/release E2E; eliminate
  `ROUTE_CROSS_J_ATOMIC_PAIR_MISSING` without relaxing atomicity.

## P0/P1 — storage integrity audit

All items use `VERIFY -> FIX or REJECT WITH EVIDENCE -> L1/L2/L3`.

- [x] Freeze valid key/hash/Merkle golden vectors before changes.
- [x] Strict 32-byte codecs for Entity IDs and hashes; reject odd, truncated,
  overlong and non-hex input; validate every parsed prefix and exact key length.
- [x] Canonical audit hash must reject NaN, Infinity, functions, symbols,
  cycles and ambiguous undefined values instead of mapping them to `null`.
- [x] Duplicate normalized Merkle keys must throw; no last-write-wins.
- [x] On load, validate LevelDB key <-> namespace/entity/path, recompute leaf,
  edge, branch and root hashes, and reject any persisted mismatch before HEAD.
- [ ] Verify frame replay against an independently computed post-state
  commitment at the first divergent height; forbid expected=actual tautology.
- [ ] Resolve the current branch's hash/domain/schema collision. Because this is
  a fresh reset, keep one format only; do not add migrations or dual readers.
- [ ] Verify the previously failing 10 SIGKILL lineage cases on current HEAD;
  fix any remaining loss of certified lineage without inventing peer recovery.
- [x] Register chunk prefix `0x7e`; prove delete/overwrite/checkpoint collection
  cannot leak orphan chunks indefinitely; document truncated checksum scope.
- [x] Add PID-reuse reproducer and bind writer ownership to process birth
  identity. A live writer cannot be stolen; a dead writer cannot block forever.
- [ ] Replace 83 manual dirty marks incrementally with reducer-returned
  `{nextState, storageChanges, durableEffects}` and differential proof for
  Account, Entity, orderbook and Runtime routing before deleting old marks.
- [ ] Prove whether `runtime/wal/store.ts`, legacy core DB and duplicate HEAD/DAG
  surfaces have production consumers; delete only demonstrated dead paths.
- [ ] Reduce frame write amplification: audit the two Runtime-machine snapshots,
  transport noise in frame hashes, duplicated replicaMeta and rebuildable
  indexes. Preserve authoritative replay and crash boundaries.
- [ ] Split oversized storage modules by append/materialize/snapshot/prune and
  current/history/recovery reads after behavior is frozen by tests.
- [ ] Add a format-discipline snapshot gate covering domain tags, algorithm IDs
  and schema version so persisted bytes cannot change without the one explicit
  format change approved for a fresh reset.
- [ ] Make history HEAD the sole recovery authority; prove deleting current DB
  rebuilds it completely. Current HEAD may remain only a cache marker.
- [ ] Add a minimal deterministic SimNetwork/SimStorage harness for seeded
  delay/reorder/drop/partial-write/kill, asserting bilateral delta conservation,
  replay==live and no double HTLC resolution. Preserve every red seed.

## Worktree integration audit

- [x] Audit `ai/input-only-wal` (`54bc6e955`) without wholesale cherry-pick.
  Its input-only frame format removes the current per-frame independent
  post-state oracle and is incompatible with the one-format mainnet candidate.
- [x] Reject its standalone `exclude pending ingress from checkpoints` patch:
  it is valid only after input-only WAL can replay that queue; on the current
  full checkpoint it would lose accepted, unprocessed ingress after restart.
- [x] Verify its signer-startup fix is superseded: Hub/MM pass every signer
  label into `main({localSigners})`, which derives/registers them before storage
  replay. Do not restore the delayed prewarm path.
- [x] Verify its payment fan-out, rebalance no-op fee, J-input budget, cross-j
  dust and paired-ACK conservation fixes are present in the current design with
  stricter bounds and current tests; do not resurrect removed legacy fields.
- [x] Port and prove its remaining resting-bid/taker-sell execution-price fix
  after owner confirmation: current protocol exposes only `source_savings`, so
  both legs must use the ask/sell price regardless of arrival order.
- [x] Audit and reject `ai/instant-swap` sparse canonical hashes (`4ae4abeae`):
  omitting the independent post-state hash on intermediate frames weakens exact
  divergence localization. Keep performance work behind differential proof.

## P1 — runtime operational correctness

- [x] Verify `managed-runtime-leases.ts` process discovery: a `ps` failure must
  fail closed, and TERM/KILL errors plus post-KILL PID state must be observable.
- [x] Verify mesh reset WebSocket cleanup: failed graceful close must remain
  tracked and use forced termination where supported; no orphan socket.
- [x] Log ABI `Error(string)` / `Panic(uint256)` decode failures with selector
  and payload length while preserving the original transaction failure.
- [x] Remove the commented historical RPC implementation after confirming no
  executable/reference value remains. Git is the history.
- [ ] Audit every empty/silent catch in production Runtime; convert to typed
  propagation or structured error logging.
- [ ] Verify and remove every HTLC cleartext fallback when recipient encryption
  material is missing; fail closed and prove browser/runtime bundles contain no
  plaintext payment secret path.
- [ ] Verify the reported shared `jReplicas` state-root assumption and collateral
  synchronization hardcoded to token 1; fix any reproduced cross-jurisdiction or
  multi-token corruption before mainnet.

## P1 — deterministic startup and signers

- [x] Runtime signer readiness is tracked on the current candidate.
- [x] Prove that every Runtime creation path derives and registers all signers
  immediately from its seed before any Entity/Account work is accepted.
- [x] Remove delayed/legacy signer bootstrap paths once all callers use the
  single constructor path; no retry fence or silent fallback.
- [ ] Bootstrap must remain deterministic and pass fresh reset, restart and
  BrowserVM scenarios.

## P1 — test system and release evidence

- [ ] Reproduce the reported unit baseline and current two failures before
  changing them: pending-frame fail-fast regression and radapter 5s timeout.
- [ ] Move the 20,050-frame/2.27-GiB 10k checkpoint rollover test from default
  unit into `test:stress:storage`; preserve it as a nightly/release gate.
- [ ] Split `unit-pure`, `unit-storage`, `integration-browser-vm`, and `stress`;
  target PR gate <=60s and record per-file duration/result JSON in QA history.
- [ ] Isolate test cleanup so it never removes build artifacts owned by a live
  dev/E2E process.
- [ ] Replace fixed E2E waits with observable state predicates. Run 10x on one
  immutable SHA before quarantining any historically flaky scenario.
- [ ] Merge duplicate payment E2E only after unique assertions are preserved in
  canonical smoke/isolated flows.
- [ ] Replace source-text production-startup tests with behavioral/typed/AST
  gates; consolidate logging-policy tests into one precise AST gate.
- [ ] Split giant fail-fast, cross-j, orderbook and QA cockpit test files by
  domain without weakening security/consensus coverage.
- [ ] Remove obsolete `test:contracts:r2r`, duplicate processbatch aliases and
  entrypoints that execute no test.

## P2 — QA cockpit

- [ ] Exclude future timestamps, fixture IDs, dirty runs and unknown schemas
  from verdicts; remove the synthetic `20991231-235959-999` contamination.
- [ ] Define `candidateId = gitHead + codeHash + gateConfigHash`; verdict uses
  only fresh mandatory gates from the same candidate.
- [ ] Record unit/contract/scenario/release results, not only E2E.
- [ ] Compare performance only against same-suite baselines; materialize median,
  p95, MAD, consecutive failures and first/last bad SHA.
- [ ] Add failure fingerprint inbox with exact rerun command and lazy evidence
  drill-down; move gallery to a separate release evidence pack.
- [ ] Replace 15s full polling with a small runs index plus event/long-poll and
  lazy details; deduplicate artifacts and define hot/cold retention.
- [ ] Deduplicate QA report types and split the ~4k-line page into small modules.
- [ ] Keep QA mostly read-only; move restart/retention/backfill controls to ops.

## P2 — TimeMachine and recovery UX

- [ ] Verify and remove legacy `EnvSnapshot[]` JSON export if it has no import or
  recovery consumer. Do not repair it as a second history format.
- [ ] Build exact offline recording from the existing canonical checkpoint +
  persisted WAL tail + manifest/hashes, using the one recovery codec.
- [ ] Open recordings through a detached read-only adapter: no P2P, command bus,
  active Runtime mutation or vault writes; load requested heights lazily.
- [ ] Keep shareable projections separate from exact replay bundles so viewing
  history does not automatically disclose complete financial Runtime state.

## Candidate and release gate

- Target: `v0.1.14` from `ai/mainnet-blockers` after every release blocker above
  is closed or explicitly rejected with evidence.
- Current branch commits include deterministic startup, atomic routing groundwork
  and signer readiness. Freeze the exact SHA only when the final gate begins.
- QA evidence upload is deferred by owner and is not a blocker for bug fixing.
- [ ] L1 and L2 evidence for every changed invariant.
- [ ] `VITE_DEV_PORT=18080 bun run check` exit 0; frozen core unchanged.
- [ ] Full unit/storage/Merkle/WAL/SIGKILL/security/contract/RPC/BrowserVM gates.
- [ ] Profile accountInput after correctness refactors; retain a CI metric and
  target <=50ms/tx per bilateral pair before publishing TPS claims.
- [ ] Full deterministic E2E green with zero browser console errors. Do not open
  or manually change the production site as a substitute for E2E.
- [ ] `bun run gate:release` and `bun run gate:mainnet` on the immutable SHA.
- [ ] Review the full diff for hacks, compatibility branches, swallowed errors,
  randomness and undocumented security assumptions.
- [ ] External audit handoff: keep `docs/security/external-audit-brief.md`
  current, deliver the immutable candidate and close every accepted finding
  before enabling real user funds.
- [ ] Commit coherent fixes, push candidate, merge into clean `main`, rerun the
  mandatory post-merge gate, tag/publish `v0.1.14`, fresh deploy/reset mainnet,
  and verify health. Stop before any irreversible action only if authority or
  owner-held credentials are actually required.

## Progress reporting

- Report overall completion as a percentage in every status update.
- Report every code/config/test change before or immediately after making it.
- Never call a task closed from a description: include exact command and result.
- If a verified finding is wrong, mark it rejected here with the code-path and
  test evidence; do not silently delete it.
