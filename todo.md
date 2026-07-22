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
  delivery receipts are unrelated and remain transport metadata. The unused
  partial-fill `receiptHash`/second hash domain was also removed: `fillId` is
  the sole idempotency identity. Later cancel flow retains an explicit committed
  book-removal ACK, not an opening/admission receipt or financial authority.
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
- [x] L3: full cross-j/security/release E2E is green without relaxing
  atomicity. Evidence on `ff8940285`: security audit pack PASS; `bun run check`
  PASS; bootstrap fresh/template/clone/hydrate 4/4 PASS; immutable run
  `20260722-103658-033` 96/96 PASS with 0 browser issues, errors, warnings,
  network failures or HTTP errors.

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
  fresh-reset format is schema 8 with SHA-256, `xln.storage.frame` and
  `storage-merkle-v1`; every older schema is rejected at the HEAD boundary. No migration,
  dual reader/writer or version-named compatibility format exists. Storage
  schema/codec/authoritative L1: 41/41 PASS, 129 assertions; types PASS. The
  inseparable descriptor also pins `xln.storage.postState`.
- [x] Verify the previously failing 10 SIGKILL lineage cases on current HEAD;
  fix any remaining loss of certified lineage without inventing peer recovery.
- [x] Replace the old content-addressed chunk layer with mutable binary
  path-addressed rebranch nodes under `0x7e`. Values remain inline below
  10,000 bytes and split only at that boundary; hashes verify content but never
  address it. Same-key overwrite diffs physical pages, shrink/delete atomically
  removes every obsolete node, and every physical value is strictly below the
  limit. L1 storage/crash/radapter: 107/107 PASS plus exact split/collapse,
  corruption and partial-write coverage.
- [x] Keep small Accounts in one LevelDB row. Oversized Accounts split into
  typed top-level field pages; `deltas`, `locks` and `swapOffers` remain one
  page per whole collection and fail fast instead of branching if that page
  reaches 10,000 bytes. Runtime enforces the same exact canonical-codec byte
  bound before commit. The browser DB reader decodes schema-8 binary Merkle
  namespaces, Account field manifests and physical rebranch nodes.
- [x] Re-audit the mutable rebranch implementation. Confirmed stale physical
  nodes and full-page rewrites were fixed atomically; duplicate diff mutations
  are canonicalized to the existing puts-then-dels final state. Rejected the
  audit's delete-then-recreate interpretation because that ordering is not a
  representable `StorageDiffRecord` operation.
- [x] Reproduce the later storage audits against the current candidate. The
  orphan-delete, missing-prefix and epoch-copy claims are stale, but the full
  live Entity loader did bypass the logical split-Account reader. It now reads
  both inline and typed-field Accounts through `readAccountStorageLayout`,
  verifies the reconstructed logical bytes and hydrates the exact Account.
  Focused layout/radapter/rebranch/real-crash/restore evidence: 122/122 PASS,
  1,101 assertions. There is no `0x25` collection-entry format.
- [x] Verify the claim that the collection byte bound can partially mutate
  consensus. Proposal and receiver validation mutate isolated Account clones;
  real-state re-execution only follows the identical successful validation, so
  the bound cannot publish a partially mutated Account. Keeping each complete
  `deltas`, `locks` and `swapOffers` collection under 10,000 bytes is the
  owner's explicit fail-fast policy, not a storage-derived financial formula.
- [ ] Extend real-process crash coverage with actual split mutation, collapse,
  delete and restore-clear physical trees; assert raw `0x7e` rows and logical
  roots after every SIGKILL boundary.
- [ ] Make storage diagnostics expose raw physical `0x7e` row count/bytes and
  linked manifest -> branch -> leaf paths/checksums in the browser DB reader,
  with laptop/mobile/wide screenshot E2E. The current reader decodes every
  binary form but presents a flat physical list.
- [ ] Add snapshot/epoch/rotation/prune and corruption matrices for oversized
  typed Account/Entity/Book values, exact 9,999/10,000-byte boundaries,
  missing/wrong/duplicate child paths and orphan-free recovery.
- [ ] Replace the three immutable proof-history CAS families (`0x2a..0x2c`)
  with snapshot-owned binary paths in a later schema. They are active retained
  history DAGs, not the mutable hot-state/rebranch address space, so the audit's
  P0 correctness claim is rejected; nevertheless their hash-addressed keys do
  not match the owner's desired all-path-addressed final storage model.
- [ ] In the same fresh schema, replace generic byte paging for oversized
  Entity/Book/record values with schema-declared owner-path Patricia fields.
  Keep small values inline, fixed binary IDs/namespaces in LevelDB keys and
  content hashes only as parent integrity checks, never as key routes. Book
  pair identity must use a compact typed binary codec rather than raw UTF-8.
- [x] Add PID-reuse reproducer and bind writer ownership to process birth
  identity. A live writer cannot be stolen; a dead writer cannot block forever.
- [x] Replace 83 manual dirty marks incrementally with reducer-returned
  `{nextState, storageChanges, durableEffects}` and differential proof for
  Account, Entity, orderbook and Runtime routing before deleting old marks.
  Phase 1 removes every direct mark from `entity/tx/**`: successful reducers
  return normalized Entity/Account changes, one interpreter applies them only
  after the tx succeeds, and rejected/unhandled txs return no change. Account
  changes delete the incremental Entity-account commitment entry so its parent
  root recomputes lazily. Differential incremental-vs-cold Merkle proof plus
  affected Entity/J/account L1 and cross-j/atomic/storage L2: 325/325 PASS,
  3,100 assertions. Phase 2 removes the Merkle editor's duplicate `dirty` bit:
  hash absence is now the sole invalidation state, every actual leaf change
  invalidates its complete parent path, and identical puts produce zero Merkle
  writes. Radix/path/unique-child guards and a strict `<10,000 byte` persisted
  node boundary fail before write/use. Storage L1-L2: 147/147 PASS, 674
  assertions; types PASS. Phase 3 binds normalized storage changes to the exact
  Entity-frame execution and applies them only with the matching committed
  frame hash. Rejected/speculative frames leave the global overlay untouched;
  Account proposal mempool removal is atomic with proposal success; Entity,
  Account and cross-j orderbook reducers no longer mark global storage directly.
  Validator execution clone/validation preserves storage and Account-J CAS
  changes. Entity/J/schema/deferred L2: 65/65 PASS; commit-boundary L1: 3/3
  PASS; source/frozen/types PASS. Phase 4 removes every scheduler-side global
  write: `scheduledWake` returns exact Account changes through the Entity
  reducer, while its Entity change is recorded once by that reducer. RuntimeTx
  mutation helpers return their changed Entity to one typed interpreter inside
  the isolated Runtime-frame transaction; failed persistence discards state,
  clock, history, overlay and restores exact input. Low-level mark functions are
  private, the dead orderbook wrapper is deleted, and production has no direct
  mark imports. Scheduler/settlement/storage/Runtime atomicity L1-L2: 98/98
  PASS, 1,733 assertions; Runtime import/J lineage: 51/51 PASS; types PASS.
- [x] Prove whether `runtime/wal/store.ts`, legacy core DB and duplicate HEAD/DAG
  surfaces have production consumers; delete only demonstrated dead paths. No
  production caller reached the parallel WAL API or empty core LevelDB, so both
  and their self-tests were removed. `PersistedFrameJournal` now derives from
  `StorageFrameRecord`. History/current HEAD and immutable nodes remain active
  as authority/cache, not parallel authorities. Net -663 LOC; types and
  storage schema/atomicity 61/61 PASS; real crash/recovery 54/54 PASS.
- [x] Reduce frame write amplification without weakening recovery. The
  replay-verifiable Runtime machine is an ephemeral per-frame hash preimage;
  the full machine is persisted only at sparse materialization/canonical-hash
  boundaries. Full `replicaMeta` now has one authoritative live copy in history
  DB and snapshots copy it there directly; current DB no longer writes, scans,
  deletes or restores a duplicate. `runtimeOutputs` remains one durable replay
  copy: it restores unsent transport and signer routing, while frame/post-state
  hashes bind the value without storing another body. Frame DB account/entity/
  activity indexes remain active bounded history APIs, not recovery authority.
  Targeted schema/crash/recovery 75/75 PASS, 720 assertions; 16-account benchmark:
  24 frames, 0 parity mismatches, 14.37 payment TPS, 2.08 MiB full snapshot,
  262 KiB maximum frame.
- [ ] Split oversized storage modules by append/materialize/snapshot/prune and
  current/history/recovery reads after behavior is frozen by tests.
- [x] Add a format-discipline snapshot gate covering domain tags, algorithm IDs
  and schema version. `STORAGE_FRAME_FORMAT` is one frozen descriptor consumed
  by frame hashing, writing and validation; its exact schema/domain/algorithm/
  hashMode tuple is pinned by `storage-schema-version.test.ts`.
- [x] Make history HEAD the sole recovery authority; prove deleting current DB
  rebuilds it completely. History is committed synchronously before the
  rebuildable current cache; a current-ahead head fails loud. The real-process
  deleted-current-cache recovery test passed inside the 54/54 crash gate.
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
- [x] Make `run-with-test-cleanup` own and stop its complete child process tree
  on SIGINT/SIGTERM. The wrapper owns one process group; `local-prod-smoke`
  idempotently stops the exact detached groups it creates before exiting. All
  three runners share one fail-loud process-group primitive (-62 duplicate LOC).
  L1: runtime types, cleanup 20/20 and supervisor 3/3 PASS; both signals remove
  child and grandchild. L2: interrupted live bootstrap exited 130 with 0
  Anvil/orchestrator PID/listeners and `E2E_PORT_SCAN_CLEAN`; normal fresh
  bootstrap then passed in 103.9s and left 0 listeners.
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

- Target: `v0.1.16` from `main` after every release blocker taken for this cut
  is closed or explicitly rejected with evidence.
- Current branch commits include deterministic startup, atomic routing groundwork
  and signer readiness. Freeze the exact SHA only when the final gate begins.
- QA evidence upload is deferred by owner and is not a blocker for bug fixing.
- [x] Make signed release publication two-phase without a red remote tip:
  generate from a clean local metadata parent, then require `publish-check` to
  prove that signed source is contained in `origin/main` and the annotated tag.
- [x] L1 and L2 evidence for every changed invariant taken for this cut.
  Final storage/radapter/crash pack: 122/122 PASS, 1,101 assertions; HTLC
  encryption/state-bound pack: 177/177 PASS, 1,350 assertions; exact real
  multiroute TC1-18 PASS in 272.7s.
- [x] `VITE_DEV_PORT=18080 bun run check` exit 0; frozen core unchanged.
- [ ] Full unit/storage/Merkle/WAL/SIGKILL/security/contract/RPC/BrowserVM gates.
- [ ] Profile accountInput after correctness refactors; retain a CI metric and
  target <=50ms/tx per bilateral pair before publishing TPS claims.
- [x] Full deterministic E2E green with zero browser console errors. Do not open
  or manually change the production site as a substitute for E2E.
  Unified run `20260722-182326-707`: 119/119 isolated targets PASS in 445.7s,
  browser errors 0, network failures 0, HTTP errors 0; warnings 64 are retained
  as non-fatal QA evidence rather than hidden.
- [ ] `bun run gate:release` and `bun run gate:mainnet` on the immutable SHA.
- [ ] Review the full diff for hacks, compatibility branches, swallowed errors,
  randomness and undocumented security assumptions.
- [ ] External audit handoff: keep `docs/security/external-audit-brief.md`
  current, deliver the immutable candidate and close every accepted finding
  before enabling real user funds.
- [ ] Commit coherent fixes on `main`, push the immutable candidate, rerun the
  mandatory gate, tag/publish `v0.1.16`, fresh deploy/reset testnet production,
  and verify health. Stop before any irreversible action only if authority or
  owner-held credentials are actually required.

## Progress reporting

- Report overall completion as a percentage in every status update.
- Report every code/config/test change before or immediately after making it.
- Never call a task closed from a description: include exact command and result.
- If a verified finding is wrong, mark it rejected here with the code-path and
  test evidence; do not silently delete it.
