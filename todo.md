# xln mainnet TODO

This is the only live TODO/NEXT file and the active blocker list for deploying
code trusted with real funds. It contains launch work only, ordered from
fastest proof/fix to the hardest external gate. Completed work is deleted;
long-term work belongs in `docs/roadmap.md`, and permanent rules belong in
`docs/mainnet-engineering-principles.md`.

## 1. Core simplification and human auditability — P0/P1, owner-approved

- [ ] Pass one final independent read-only audit on an immutable release
  candidate SHA. The auditor must verify the current code and recent diffs
  rather than trust comments or prior reports, run `check:src` and `check`,
  and produce reproducible findings with execution path, file/line evidence,
  measurement, minimal fix, deletion impact, tests and migration risk. Require
  scored evidence for correctness, determinism, financial safety, recovery,
  performance architecture, type safety, naming, folder ownership,
  decoupling, human auditability and tests. Require an actual value-import
  graph/SCC report, complexity ledger, call-site-proven delete list, ideal
  owner tree with before/after edge counts, reviewable PR sequence and a
  60–120 minute one-dollar reading path from external observation through
  R→E→A, WAL and history. Mechanically record production LOC by owner, files
  and functions over the ratchets, converter/representation count, unsafe
  casts, suppressions, aliases, reverse edges, duplicate exports, reducer/root/
  clone/WAL/view latency and critical transition coverage. Reject generic
  framework advice, symmetry-only abstractions, speculative vulnerabilities,
  folder churn without fewer edges, optimization without frame-path evidence,
  and any finding that ignores xln's nonce, Hanko, LEFT tie-break, single
  Runtime writer or durable WAL model. The release audit is complete only when
  every accepted finding is closed or explicitly owner-deferred outside the
  release scope; do not copy the report into a second permanent backlog.
  Require three executable reading traces: one unit of value from external
  ingress through R→E→A, signed child frames, WAL, history view and UI; one
  simultaneous same-height Account proposal proving rollback ordering and
  LEFT-wins; and failures before mutation, after mutation/pre-WAL, post-WAL,
  during RPC observation and during multi-signer root verification. For every
  stage identify authoritative state, public visibility and retry/drop/halt
  behavior. Keep source code, comments, errors and canonical documents in
  English. Intentional localization and multilingual user content are allowed
  only through the exact localization-assets allowlist.
- [ ] Make the audit surface mechanically legible after the function split.
  Keep production runtime at zero explicit `any` and zero TypeScript
  suppressions; drive the exact `as unknown as` debt to zero through typed
  boundary decoders/adapters. The AST ratchet must reject every new occurrence
  and every increase. Decode untrusted WAL/P2P/RPC/LevelDB data exactly once,
  then pass canonical types through reducers instead of scattering defensive
  guards through trusted financial code.
  Remove duplicate constructors/policies/serializers only after proving one
  canonical owner, delete dead exports only after static and dynamic
  entrypoint/call-site checks, and add concise comments at every financial
  invariant, WAL boundary, adversarial-input boundary and intentionally
  non-obvious ordering rule. Comments must explain why the tempting alternative
  is unsafe rather than restating the code.
- [ ] Separate committed frame state from each replica envelope before
  optimizing further. Introduce the missing `RuntimeReplica` boundary around
  committed `RuntimeState`, ingress, WAL/outbox, lifecycle and process-local
  infrastructure. Remove history/UI/transient collectors from `EntityState`
  and type its Account map as the exact deterministic Account-replica view
  committed by the Entity root. Keep validator-local Hankos, keys, transport,
  watchdogs and retry metadata in replica-owned storage. First pin
  byte-identical Account, Entity and Runtime roots, replay, pre-WAL failure,
  post-WAL recovery and browser snapshots. Preserve the intentional parent
  commitment: EntityState binds deterministic Account proposal/ACK/resend
  state with post-commit Hankos stripped, while AccountStateRoot binds only
  bilateral `AccountState`. Replace implicit field-deletion projections with
  explicitly named byte-identical projections.
- [ ] Give every nested machine one explicit deterministic input boundary.
  Keep the existing canonical `RuntimeInput`, `EntityInput`, and `AccountInput`
  boundaries and the WAL fence rejecting local `AccountInput(kind='txs')`
  inside an `EntityTx.accountInput`. Finish the remaining proof: validate pair
  endpoints, domain and watch seed before every Account dispatch, preflight one
  complete local `txs` batch, and install it atomically. Preserve transaction
  order, multiplicity, exact-payload idempotency, and the documented
  deterministic LEFT-wins rollback.
- [ ] Pin the financial and durability baselines before structural changes.
  Keep the existing cold/incremental Account and Entity root, reliable
  frontier, sticky-halt, post-WAL and candidate-abort regressions. Add the
  missing exact payment/HTLC/settlement/rebalance golden vectors, measured
  clone/apply/WAL/dispatch p50/p95, and an executable public-facade/browser
  bundle trace.
- [ ] Finish the canonical Activity projection and local crypto ownership.
  Keep canonical ordered Entity/Account event receipts inline in their signed
  Frame and covered by its Hanko; do not add a second Merkle tree unless
  measured frame sizes require one. Complete the exact typed
  `ActivityEvent` projection for Entity, Account, and authenticated J events
  with deterministic event id, source machine/frame/hash/index, scopes, actor,
  kind, and payload. Keep the disposable LevelDB view exactly rebuildable from
  the authoritative Runtime WAL and certified child frames. Move display text,
  local notes and validator-private encryption material out of committed State;
  prove dynamic/browser entrypoints, recovery hydration and roots with one
  testnet schema and no fallback reader.
- [ ] Store Runtime, Entity, Account, and J histories across three explicit
  physical roles: rebuildable hot `current`, authoritative epoch-rolled
  `runtimeWal`, and rebuildable `historyViews`. Runtime WAL epochs are a
  compaction detail and must not partition certified Entity/Account chains.
  Key certified Entity
  frames by entity/height/hash with their certificate; key accepted Account
  frames by canonical pair/height/hash with Hanko, ACK, and same-height
  collision evidence. Record losing candidates only as evidence, never as the
  canonical Account chain. Commit each Runtime frame first with its exact
  certified child-frame records and Activity inputs inside the WAL hash. Only
  then advance the idempotent history-view cursor. A crash between databases
  never rolls back Runtime: startup replays WAL heights after the cursor.
  Keep only latest committed R/E/A state plus one necessary in-flight candidate
  in RAM. Owner clarification: an operator reset creates a new network/genesis,
  not a new epoch of the existing network. Epoch rotation is a separate local
  history-compaction mechanism for reducing Hub storage weight; it must
  preserve network identity and continuous certified Entity/Account chains.
  Use one canonical `EncryptedRecoveryBundle` for local files, remote
  watchtowers, and machine-to-machine transfer. `storage/recovery` owns its
  deterministic codec and restore; `api/recovery` exposes import/export;
  `watchtower/recovery` stores and transports the same opaque encrypted bytes.
  Live WAL/checkpoints are internal working storage, not a competing portable
  bundle format. Add no versioned compatibility reader or fallback codec.
- [ ] Make long-term history retention independent per replica. Add certified
  checkpoints containing machine id, height, state root, previous checkpoint
  hash, and certificate; permit each Entity validator/Account peer to prune
  old local frame bodies only after its configured archival policy is
  satisfied. Full-history validators/watchtowers may retain or export immutable
  segments forever. A pruned node must recover from a verified checkpoint plus
  later frames, without consulting a Runtime epoch or accepting an
  unverifiable state snapshot. Activity indexes remain disposable and
  rebuildable; signed dispute/evidence records use an explicit longer
  retention class. Retain history forever by default. Pruning is an explicit
  local opt-in and requires a verified checkpoint before any frame body is
  removed. The user-facing Activity stream contains committed facts only.
  Rejected untrusted inputs are not durable data: emit bounded operational
  metrics/logs without retaining their payloads in Runtime state or history.
- [ ] Prove and fix the likely unilateral rebalance consensus wedge first.
  Reproduce bilateral request → reverse payment/self-pay → hub crontab and
  assert equal Account roots and pending state on both peers. Crontab must
  never locally delete canonical `requestedRebalance` or fee state; replace
  confirmed paths with explicit bilateral Account transitions, invalidate
  commitment caches before hashing, and clear `submittedAtByToken` on the
  canonical full-refund transition. Keep this protocol fix separate from
  Runtime ingress refactoring. Give every successful R→C request one durable
  `requestId → batchHash/opIndex/outcome` owner: withholding the bilateral
  claim must never let the hub spend reserve twice, and abort/requeue must
  rebroadcast or rebuild exactly once rather than doubling the draft amount.
  First prove whether `handleR2C` and `queueR2CTargets` are two legitimate
  phases of one lifecycle or two producers. Keep both only if a trace proves
  that the Entity transaction creates the canonical bilateral request while
  crontab exclusively materializes that same request into one J batch.
- [ ] Finish canonical financial construction and naming. Empty Deltas now use
  the Account-owned constructor, hold fields are mandatory, and Account-frame
  validation names are canonical. Centralize the remaining settlement-Hanko
  projection and RuntimeState symbols. Keep exactly three semantic verb
  families: `decode*` for unknown/wire → typed and throw, `assert*` for a typed
  invariant and throw, and `is<Decision>*` for one boolean decision.
- [ ] Finish mechanically enforcing the money boundary. Settlement finality
  already queues an Account-owned `j_event_claim`; dispute finality now builds
  an explicit `AccountInput(kind='external_finality')` and enters the same
  `applyAccountInput` composition root. Authenticated `DisputeStarted` uses
  that same Account-owned boundary; Entity authenticates the event and
  schedules follow-ups without writing Account dispute fields. The
  Account-owned branch applies authenticated chain finality immediately and
  unilaterally, without Account mempool, proposal, or peer ACK, so either party
  cannot veto an on-chain result. The returning peer independently consumes
  the same finalized event and converges byte-identically. Extend the ownership
  gate from J-event dispute fields to every Account State mutation, forbidding
  Entity/Runtime writes to Account delta, collateral, holds or credit outside
  calls into Account-owned handlers.
- [ ] Move multi-frame settlement continuation out of Svelte and into the
  deterministic Entity machine. A `settle_propose` intent must commit the
  exact allowed post-settlement continuation and broadcast policy in
  `EntityState`; Account remains the sole owner of workspace, Hanko and money
  transitions. After a committed Account frame reaches `ready_to_submit`, the
  Entity reducer materializes exactly one `settle_execute`, then its bounded
  `r2r`/`r2e`/`r2c` follow-up and optional `j_broadcast`. Bind the continuation
  to the exact counterparty, workspace revision/hash, ops and executor; reject
  replacement, stale or mismatched work fail-fast. Clear it only after the
  corresponding Account submit transition and follow-up are committed in the
  same Entity frame. Remove `pendingAssetAutoC2Rs`, reactive promises, polling
  and timeout ownership from the frontend: reload or a closed browser must not
  stop, duplicate or reorder finance. Prove plain C→R, every follow-up, manual
  draft, automatic broadcast, restart/replay, multi-signer candidate parity
  and byte-identical roots.
- [ ] Turn Runtime execution into one visible pipeline:
  `take → validate/plan → mutate owned Runtime → WAL → dispatch`.
  Install one external read barrier from the first mutation through WAL commit:
  server/radapter/API readers wait or return an explicit busy result, and UI
  publishes only post-commit snapshots. The single writer prevents competing
  transitions, not asynchronous reads during the WAL `await`; no caller may
  observe speculative balances from the owned live object.
  Close the currently proven gaps in `server/entity-lookup.ts`,
  `server/health.ts` and direct frontend Runtime references.
  Extract transaction, commit, recovery and dispatch modules; keep
  `runtime/core.ts` a short composition root with no alternate commit path.
  Precompute every expected throwing assertion before mutation; any doubt
  before or after WAL halts and reloads durable truth. Operational notifications happen only
  after the durable result is fixed and can report failure but never reclassify
  or roll back that result. `env.warn`, `env.error` and special info diagnostics
  must queue network-visible diagnostics and flush them only after WAL commit.
  A rejected frame may log locally but must be externally unobservable.
- [ ] Complete the remaining candidate-safety evidence. Persist a signing lock
  in every Runtime WAL frame
  that may dispatch a local precommit, before that signature becomes externally
  visible, so restart cannot double-sign. Validator removal remains governance.
  Prove happy-path work remains O(touched state), unrelated Entities continue,
  and Account remains the small isolated bilateral boundary. Add differential
  roots and perf budgets for touched clone bytes, reducer latency and WAL
  latency; preserve the gate forbidding full Runtime and single-signer Entity
  clones.
- [ ] Make post-state Runtime ingress rejection explicit and deterministic.
  Inputs admitted against frame H may become stale after the single writer
  commits H+1. Classify expected authenticated nonce/board/order conflicts as
  an explicit terminal protocol outcome, distinct from malformed ingress,
  invariant faults and storage failure; consume the exact stale origin once
  without halting Runtime. Add queued-writer stale-input and board-rotation
  regressions. In production, malformed remote ingress is consumed and dropped
  without a quarantine, forensic receipt or consensus-frame inclusion. In
  dev/test it fails loudly so the defect is fixed. Mixed-batch retention is
  already pinned and must remain unchanged.
- [ ] Replace `prod-startup-wiring.test.ts` source-text assertions with
  executable boundary/boot tests so refactors cannot pass or fail because of
  spelling. Keep the enforced budgets at zero production functions over 150
  lines, zero R/E/A functions over 100 lines and zero files over 3000 lines.
- [ ] Enforce an acyclic browser-safe core dependency graph. Keep cloning,
  codecs and state helpers as leaf modules that never import reducers,
  Runtime routing or chain adapters. The value graph is already acyclic
  (`maxValueScc=1`, no reverse/root debt); keep that gate green. Execute
  SHA-256, proposal construction and one Account open from the actual browser
  bundle, not only Bun source imports. Programming faults such as `TypeError`
  must preserve their source stack and halt, never be relabelled as rejected
  input.
- [ ] Remove only call-site-proven dead code in small module-owned batches.
  Reverify dynamic imports, scenario/CLI entrypoints and browser API first;
  `runNumberedRegistrationIntent` is currently live scenario infrastructure,
  not dead code. Delete proven topology, ID/hash-ladder, validation/logger,
  wallet/helper, retention/hook, lookup/barrel and rename-only orphans.
  The old audit's named deletion batch has been exhausted or disproved on the
  current tree; discover the next candidates from current call sites instead
  of carrying that stale list forward.
  Introduce `EntityOutput` only as the real reducer-to-parent boundary required
  above; do not invent empty `RuntimeOutput` or `AccountOutput` aliases merely
  for naming symmetry. Derive output unions only from real reducer results.
  Public API removals require an explicit compatibility decision.
- [ ] Complete the verified owner-path cleanup and ratchet every removed edge:
  move persistence query/history DTOs out of `radapter` and `api`. Internal
  Runtime and storage modules must import concrete JAdapter owners, never its
  public facade. These are path/ownership batches only; do not mix them with
  protocol behavior changes. The Activity projection move waits for the
  independently edited Time Machine/3D consumer so no compatibility re-export
  or cross-worktree conflict is introduced.
- [ ] Replace the remaining generic/fallback configuration and routing shapes:
  require exact owner schemas for every remaining control/config object. Add
  dependency gates for the newly corrected directions so the old import graph
  cannot return.
- [ ] Remove duplicate policy and display code: use canonical Account
  `Delta`/`DerivedDelta` and `deriveDelta` in the dev visualizer and Graph3D;
  BigInt remains exact until the geometry/formatting boundary. Fix the stale
  source comment and add exact revoked-credit-debt screenshots. Replace the
  handwritten `XLNModule` and duplicate cross-J DTOs with exact canonical
  runtime-module types and an exact-key compile-time export test. Centralize
  bootstrap credit policy; share JAdapter watcher orchestration; use one
  post-restore digest assertion for boot/checkpoint/bundle/import recovery.
- [ ] Move numbered-registration chain I/O out of `runtime/entity/`.
  `externalTokenToReserve` is pure J-batch data and is not the nonce reader.
  The live path is `runNumberedRegistrationIntent → submit...`, used by the
  scenario executor. Keep reducer state deterministic, serialize submission
  through an explicit Runtime/J-adapter outbox using Entity-committed intent
  data, and add a source gate forbidding provider, wall-clock and randomness
  access under deterministic Entity/Account/protocol code.
- [ ] Profile a growing hub only after the structural work. Do not introduce
  Runtime→Entity→Account COW, optimistic batching or remove receiver
  validation without byte-identical differential roots, equivalent failures
  and measured improvement. Include stale-bundle detection in performance
  evidence; performance changes stay separate from money/refactor changes.
  Record WAL bytes/frame, durable commit latency p50/p95/p99 with fsync,
  crash-replay time per recovered height, and current-cache rebuild time.
  Prove incremental Entity/Account roots equal cold recomputation with
  differential randomized transaction sequences. Benchmark growing hubs at
  10k, 100k, and 1M accounts before claiming a path to 10M accounts/10k TPS.
  The full topology gate is one million separate durable user Runtimes, each
  owning its Entity and bilateral Account against one 3-of-4 Hub Entity. Keep
  all logical Runtimes on disk, materialize a measured hot working set, and
  count only quorum-certified plus WAL-durable Account transactions as TPS;
  explicitly measure full Runtime replica clone bytes, entity-root account
  traversal, loaded Account working-set size, LevelDB compaction stalls, and
  batch/group-commit throughput. Touched-only state or DB-backed Account state
  requires these proofs and remains a separate performance design, never an
  opportunistic consensus refactor.

## 2. Contract boundedness — P0/P1, owner-approved
- [ ] Remove the remaining proven pre-mainnet compatibility ABI/state:
  migrate V1 settlement `diffsToOps` and `position.xlnomy`, then delete unused
  contract `resolveEntityId` and ineffective `hashToBlock/cleanSecret`. Use one
  schema/ABI change with no legacy decoder or fallback. `RuntimeState.browserVM` is
  currently live infrastructure, not dead code; do not delete it as an audit
  shortcut.

## 3. Transport and secret persistence — P0/P1, owner-approved

- [ ] Enforce one canonical transport-hop matrix and reject every accidental
  loopback/proxy/relay detour. A normal user Runtime opens one authenticated
  direct WebSocket to the Hub's public server; the Hub keeps that live socket
  in its bounded in-memory connection registry and sends replies and Account
  traffic back over the same bidirectional socket. Hub Runtimes connect
  directly server-to-server with deterministic duplicate-socket ownership.
  Relay transport is reserved for user-to-user delivery when neither user is
  the connected Hub endpoint; user-to-Hub, Hub-to-user and Hub-to-Hub traffic
  must never bounce through a local relay or a second loopback WebSocket.
  Preserve the durable Runtime outbox and signed delivery receipts above the
  transport choice. Add an executable topology matrix that records exact
  source, target, socket identity, selected transport and hop count; assert one
  hop for both direct classes, same-socket reverse delivery, bounded registry
  cleanup/reconnect, no duplicate live authority, and relay-only user pairs.
- [ ] Make off-chain faucet admission durable without adding production-style
  friction to the intentionally open testnet faucet. The server assigns a
  request id, waits until the Runtime command has a durable WAL receipt before
  returning success, and exposes that receipt for polling/recovery. Do not
  require authentication, rate limits, or a client idempotency key: repeated
  calls are intentionally new faucet grants. Prove a crash before durability
  never returns success and a crash after durability never loses the accepted
  grant.
- [ ] Derive AEAD keys from X25519 with domain-separated HKDF-SHA256 and bind
  protocol/from/to/type/source-frame/message-id as AAD. Replace Base64 with one
  binary wire atomically, reject low-order/shared-zero keys, keep strict
  signed-profile key authority, and reject duplicate authenticated session
  sequence/message IDs through one bounded replay window before dispatch; no
  legacy codec.
- [ ] Mutually authenticate the direct hello challenge, both Runtime IDs and
  the responder encryption key. Add authenticated session-key rotation and
  prove recorded traffic cannot be decrypted after later compromise of the
  static Runtime key.
- [ ] Enforce WebSocket backpressure and per-Runtime byte/message rate limits
  from one typed limit source shared by WS, Runtime ingress and Entity frames.
  Replace 250 ms bootstrap polling overrides with authenticated initial sync,
  relay push updates, a monotonic cursor, exact lookup on cache miss and bounded
  30–60 second reconciliation.
- [ ] Stop persisting a full replay Runtime-machine projection in every WAL
  frame. Store deterministic ingress, roots, frontier/outbox changes and
  bounded checkpoints; prove crash/replay/import parity and WAL reduction.
- [ ] Store each bilateral watch seed once in an encrypted Runtime secret
  namespace and reference it from Account materialization. Prove backup,
  restore and dispute recovery before removing plaintext duplication.

## 4. Crash, corruption and load evidence — P1, open
- [ ] Add one real Anvil contract-event dispute E2E after payment, HTLC,
  same-J/cross-J swap and pull state. Exercise malformed/oversized optional
  transformer arguments, compare final Depository reserves/debts to the
  canonical Runtime preview, and SIGKILL at WAL-before-dispatch and
  dispatch-before-receipt without double application.
- [ ] Profile the production bootstrap and growing-hub frame path locally.
  Remove only measured full scans/clones/duplicate crypto; publish deterministic
  1/1,000-tx and growing-hub median/p95/MAD budgets from a clean Bun cache.
  Measure the duplicate Account wake scan, per-frame verified-profile clone and
  repeated cross-J atomic-admission scratch execution; replace them only with dirty/versioned
  indexes or structural preflight proven byte-identical. The first indexes are
  one ephemeral `proposableAccountKeys` queue and a canonical
  `(entityId, signerId) → replicaKey` map rebuilt on restore/import. Record
  `frameCloneMs`, cloned replica/account/profile counts, estimated cloned bytes
  and cross-J scratch execution time. A frame touching one account must not scale
  linearly when untouched accounts grow from 10,000 to 100,000.
  Benchmark signature/verification/Hanko throughput separately from reducers
  before claiming 100k tx/s.
- [ ] Replace case-insensitive Account scans and repeated signer/pair lookups
  with canonical direct indexes, including exact cross-J replica/account
  descriptors; then introduce Runtime→Entity→Account COW only behind
  byte-identical differential roots and measured clone counters.

## 5. Public Ethereum proof — P0 release blocker, open

- [ ] Prove Runtime ↔ Sepolia debt parity, restart/replay and chain-domain
  deadlines. Reserve parity above does not cover any of these three.
- [ ] Prove the cross-J lifecycle with the Sepolia leg: full fill, partial GTC
  and manual close.
- [ ] Freeze one unchanged candidate SHA and re-run the above as immutable
  evidence, rather than across the several runs that produced them today.

## 6. Immutable mainnet release pipeline — P0 release blocker, open

- [ ] Extend the candidate binding already enforced for isolated E2E run/shard
  manifests to unit, contract, scenario, recovery, public-chain and final
  release evidence. One `candidateId = gitHead + codeHash + gateConfigHash`
  must identify the entire immutable evidence set.
- [ ] Run L1/L2 first, then exactly one unchanged-candidate unified full E2E,
  `bun run check`, `bun run gate:release` and the uninterrupted
  `bun run gate:mainnet`. Every financial browser E2E must use the same
  mandatory console/page/request fatal guard; eventual DOM success cannot hide
  a browser or Runtime error.
- [ ] Complete an independent contract/runtime audit on the immutable SHA with
  conservation, fuzz, dispute and recovery evidence plus public deployment
  receipts and explicit known limitations.
- [ ] Merge only the proven SHA into clean `main`, tag, publish, deploy the
  production servers/contracts, verify live health and books, and upload the
  unified story videos plus API evidence.

## 7. Hub capital markets — post-core protocol, owner-approved

- [ ] Expose the C/D share model already defined by `EntityProvider.sol`
  without inventing a parallel finance protocol. C is the control class:
  sufficient holder authorization may propose a new board for that `entityId`.
  D is the economic/dividend class. Both fixed supplies initially belong to
  the Entity, may be released for trading through Depository, and settle
  delivery-versus-payment through the existing orderbook and bilateral
  Accounts. An Entity buyback is an ordinary order for its own C or D shares;
  no privileged buyback path or synthetic asset is needed.
- [ ] Mirror the existing on-chain governance lifecycle exactly in Runtime and
  Activity: collect signatures from holders of strictly more than half of the
  relevant fixed share supply, propose the new board, wait that authority
  class's configured activation delay, activate it, and retain the previous
  board for the explicit seven-day post-activation grace. C and D holders may
  both propose through their respective authority lanes; C has the higher
  priority and their delays may differ. Share transfer alone never changes the
  board.
- [ ] Implement scalable dividend declaration and claims for D shares without
  iterating every holder in one Entity frame. Bind each distribution to a
  deterministic record point and conserved treasury amount; holders claim
  through bounded Account transactions with replay-safe evidence. C ownership
  and D economics remain separate even when one address owns both classes.
- [ ] Add cap-table, treasury, governance and Activity views plus real E2E for
  C/D release, primary and secondary trading, Entity buybacks, dividend
  declaration/claim, C-authorized board proposal and delayed activation. Use
  the one testnet schema directly: no v2, legacy reader, fallback settlement,
  debt/coupon semantics or privileged off-ledger ownership.
