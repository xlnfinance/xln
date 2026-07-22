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
- [x] L2: exact isolated full/partial/cancel/dispute flow on `d8e6f1954`:
  Playwright 1/1 PASS, strict isolated runner PASS in 49.3s.
- [x] L2: packet loss/reorder and live restart during one intact cross-j
  envelope. `cross-jurisdiction-swap`, `output-routing-reliable-order` and
  `durable-output-retry`: 119/119 PASS, 769 assertions in 5.76s. A reversed
  two-leg proposal is accepted; one leg commits nothing; a simulated lost
  packet persists both legs plus the manual pause through real WAL close/load,
  and the explicit retry emits exactly one two-input envelope.
- [x] Keep routing/profile financial capacities native `bigint` after the
  canonical `parseProfile` wire boundary. Remove the duplicate generic
  capacity parser, string-backed signed descriptor values, routing catch/drop
  fallback and browser `eth_getCode` fetch fallback. Evidence on `e1001546`:
  22/22 focused tests PASS; exact payment + cross-j 2/2 PASS with strict browser
  health; deriveDelta/manual-math/frozen-core gates unchanged.
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
- [x] Verify every frame replay against an independently recomputed
  `postStateHash = H(height, timestamp, replicaMetaDigest, durable machine)`;
  Entity heads bind validator-recomputed state roots and the compact Runtime/J/
  outbox machine is checked at the first divergent height. A validly re-chained
  height-2 tamper fails exactly at height 2. Storage/WAL L1-L2: 133/133 PASS,
  1,611 assertions; types PASS. Operator-only `runtimeConfig` is deliberately
  excluded because it can change without an RJEA input. Benchmark impact:
  868.04ms -> 870.33ms for 16 payments (+0.26%, 18.43 -> 18.38 TPS).
- [x] Resolve the current branch's hash/domain/schema collision. The only
  fresh-reset format is schema 7 with SHA-256, `xln.storage.frame` and
  `storage-merkle-v1`; schema 6 is rejected at the HEAD boundary. No migration,
  dual reader/writer or version-named compatibility format exists. Storage
  schema/codec/authoritative L1: 41/41 PASS, 129 assertions; types PASS. The
  inseparable descriptor also pins `xln.storage.postState`.
- [x] Verify the previously failing 10 SIGKILL lineage cases on current HEAD;
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
- [x] Add a format-discipline snapshot gate covering domain tags, algorithm IDs
  and schema version. `STORAGE_FRAME_FORMAT` is one frozen descriptor consumed
  by frame hashing, writing and validation; its exact schema/domain/algorithm/
  hashMode tuple is pinned by `storage-schema-version.test.ts`.
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
- [x] Audit dirty worktrees, not only commits: port the missing authenticated
  nested Account sender route hint with a focused regression; reject per-frame
  recovery info spam; retain the current green storage benchmark API instead
  of the stale four-argument `saveEnvToDB` call.
- [x] After main merge, remove merged/superseded worktrees and their branches;
  preserve no worktree as an archive. `git worktree list` now contains only the
  clean root `main` and this candidate worktree. All other `ai/*` branches were
  either proven ancestors of `948aea5bc` or explicitly rejected above; dirty
  sender-route and benchmark edits were verified present in `main` before their
  superseded worktrees were removed.

## P1 — runtime operational correctness

- [x] Verify `managed-runtime-leases.ts` process discovery: a `ps` failure must
  fail closed, and TERM/KILL errors plus post-KILL PID state must be observable.
- [x] Verify mesh reset WebSocket cleanup: failed graceful close must remain
  tracked and use forced termination where supported; no orphan socket.
- [x] Log ABI `Error(string)` / `Panic(uint256)` decode failures with selector
  and payload length while preserving the original transaction failure.
- [x] Remove the commented historical RPC implementation after confirming no
  executable/reference value remains. Git is the history.
- [x] Eliminate every literal empty catch in production/runtime/scripts. The 15
  cleanup failures emit operation, PID/path where relevant, and the error;
  production WebSocket diagnostics fail on close errors, and corrupt news
  budget files fail closed instead of silently resetting the spend counter.
- [x] Audit semantic silent fallbacks in remaining catch clauses; retain only
  typed validation results or explicitly documented adversarial soft-fail paths.
  Operational uncertainty now fails closed for process/runner leases, log and
  persistence reads, signer availability, routing capacity, watchtower delay,
  support-peer identity, local replica keys and scenario adapters. Adversarial
  profile/evidence decoders remain isolated typed rejection paths. L1/L2:
  109/109 targeted tests (1,675 assertions), six adapter scenarios COMPLETE,
  runtime types and `check:src` PASS; frozen core unchanged.
- [x] Reject malformed Hub support-peer identity JSON as one invalid config;
  never silently drop one/all MM sibling identities and continue bootstrap.
- [x] Verify and remove every HTLC cleartext fallback when recipient encryption
  material is missing; fail closed and prove browser/runtime bundles contain no
  plaintext payment secret path.
- [x] Reject the stale shared-`jReplicas` state-root/token-1 report on current
  code: no production assignment or hardcode remains; jurisdiction authority is
  exact `(chainId, Depository)`. Multi-j/source-binding/security: 26/26 PASS.

## P1 — deterministic startup and signers

- [x] Runtime signer readiness is tracked on the current candidate.
- [x] Prove that every Runtime creation path derives and registers all signers
  immediately from its seed before any Entity/Account work is accepted.
- [x] Remove delayed/legacy signer bootstrap paths once all callers use the
  single constructor path; no retry fence or silent fallback.
- [x] Bootstrap must remain deterministic and pass fresh reset, restart and
  BrowserVM scenarios.

## P1 — test system and release evidence

- [x] Reject the reported two unit failures on current HEAD before changing
  code: pending-frame 10/10 PASS (p95 142ms); radapter root metadata 10/10 PASS
  (max 2.524s under the unchanged 5s timeout).
- [x] Move the 20,050-frame/2.27-GiB 10k checkpoint rollover test from default
  unit into `test:stress:storage`; preserve it as a nightly/release gate.
- [ ] Split `unit-pure`, `unit-storage`, `integration-browser-vm`, and `stress`;
  target PR gate <=60s and record per-file duration/result JSON in QA history.
- [x] Isolate test cleanup so it never removes build artifacts owned by a live
  dev/E2E process; token/PID lease and SIGKILL-child ownership pass in the
  3,111-test unit gate.
- [ ] Make `run-with-test-cleanup` own and stop its complete child process tree
  on SIGINT/SIGTERM. Reproduce an interrupted bootstrap and prove no orphan
  Anvil/orchestrator listener survives to block the next E2E port scan.
- [ ] Replace fixed E2E waits with observable state predicates. Run 10x on one
  immutable SHA before quarantining any historically flaky scenario.
- [ ] Merge duplicate payment E2E only after unique assertions are preserved in
  canonical smoke/isolated flows.
- [ ] Replace source-text production-startup tests with behavioral/typed/AST
  gates; consolidate logging-policy tests into one precise AST gate.
- [ ] Split giant fail-fast, cross-j, orderbook and QA cockpit test files by
  domain without weakening security/consensus coverage.
- [x] Remove obsolete `test:contracts:r2r`, duplicate processbatch aliases and
  entrypoints that execute no test. Deleted the post-deploy script that called
  the deliberately absent `unsafeProcessBatch`, removed its deployment hook and
  the `process-batch` alias. Current Hanko ABI guard: 1/1 PASS; canonical RPC
  `processbatch` scenario PASS; obsolete references: 0.

## P2 — QA cockpit

- [x] Exclude future timestamps, fixture IDs, dirty runs and unknown schemas
  from verdicts; remove the synthetic `20991231-235959-999` contamination.
  Verdict selection now accepts only current schema v4, valid non-future run IDs
  and timestamps, explicit non-fixture manifests and clean code fingerprints.
  Historical rows remain inspectable but cannot decide a release. The synthetic
  2099 row/directory is absent. QA report L1/L2: 44/44 PASS; runtime types PASS.
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

- [x] Verify and remove legacy `EnvSnapshot[]` JSON export if it has no import or
  recovery consumer. No importer or recovery consumer exists; removed the raw
  `JSON.stringify($history)` download and its TimeMachine UI instead of creating
  a second history format. The transient `EnvSnapshot[]` projection remains only
  for live/local UI playback.
- [x] Build exact offline recording from the existing canonical checkpoint +
  persisted WAL tail + manifest/hashes, using the one recovery codec. Recording
  is only a signed recovery snapshot plus optional contiguous recovery journal
  tail; manifest pins every bundle hash and itself. A pruned base falls back to
  an exact signed live snapshot rather than inventing another codec.
- [x] Open recordings through a detached read-only adapter: no P2P, command bus,
  active Runtime mutation or vault writes; load requested heights lazily. The
  adapter restores only the requested signed height in memory, skips infra
  rehydration/retry activation, and never opens/closes the live DB namespace.
  Recovery/recording L1-L2: 10/10 PASS, 118 assertions; runtime types PASS.
- [ ] Keep shareable projections separate from exact replay bundles so viewing
  history does not automatically disclose complete financial Runtime state.

## Candidate and release gate

- Target: `v0.1.14` from `ai/mainnet-blockers` after every release blocker above
  is closed or explicitly rejected with evidence.
- Current branch commits include deterministic startup, atomic routing groundwork
  and signer readiness. Freeze the exact SHA only when the final gate begins.
- QA evidence upload is deferred by owner and is not a blocker for bug fixing.
- [x] Make signed release publication two-phase without a red remote tip:
  generate from a clean local metadata parent, then require `publish-check` to
  prove that signed source is contained in `origin/main` and the annotated tag.
- [ ] L1 and L2 evidence for every changed invariant.
- [x] `VITE_DEV_PORT=18080 bun run check` exit 0; frozen core unchanged.
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
