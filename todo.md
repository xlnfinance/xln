# xln mainnet TODO

This is the only live TODO/NEXT file and the active blocker list for deploying
code trusted with real funds. It contains launch work only, ordered from
fastest proof/fix to the hardest external gate. Completed work is deleted;
long-term work belongs in `docs/roadmap.md`, and permanent rules belong in
`docs/mainnet-engineering-principles.md`.

## 1. Core simplification and human auditability — P0/P1, owner-approved

- [ ] Enforce the canonical Runtime → Entity → Account cascade documented at
  the top of `AGENTS.md` as the first architecture gate. Use the same
  `*Machine/*Replica`, `*State`, `*Input`, `*Tx`, `*Frame`, `*Output` and phase
  vocabulary at every layer without a shared base class. Inputs control their
  machine and contain that layer's transactions; outputs return to the parent;
  only Runtime interprets committed outputs as post-WAL external effects.
  Delete or correct docs, comments, types and helpers that blur local
  `AccountTx[]` with signed bilateral `AccountInput`.
  Keep the AST-ratcheted reverse-import debt at the verified zero: lower Account code must
  not import Entity, Runtime, adapters or physical storage; Entity must not
  import Runtime, adapters, networking or physical storage; shared protocol
  leaves must not import machine implementations; HTTP server handlers must not
  reach upward into process orchestration. Move the shared primitive to its
  canonical owner or pass a narrow dependency explicitly—never hide a reverse
  edge behind a re-export.
- [ ] Close the still-live findings from the GPT audit of
  `main@fddcac8bab9420f48168b0453cc05419f858f392`, reverified against
  `main@f1de788d87619ff85a944df382cdb8b8ca02a979` instead of copying stale line
  numbers. A second GPT read-only audit of the same old SHA independently
  reported the same financial/runtime findings; it adds no new accepted item
  until each claim is reproduced on current `main`. Current-code inspection
  confirms the R→C duplicate lifecycle (`FIN-01/02`), unsafe dispute
  `uint256 → Number` conversion (`FIN-03`), fail-open rebalance construction
  (`FIN-04`), non-durable faucet admission (`SRV-01`) and duplicate/inexact UI
  money models (`UI-01`). `ARCH-01` is partly closed: finalized Account
  J-claims now apply through Account-owned handlers, but dispute-finality still
  mutates Account money state from Entity and remains open.
  Reproduce `RUN-04` against the current single Runtime mempool before accepting
  its old “concurrent ingress” explanation:
  one writer is intentional, but a queued input can still become stale after
  the preceding committed frame. Do not reopen already-fixed findings:
  sticky-halt waiter recheck (`RUN-01`), post-WAL notification isolation
  (`RUN-02`), candidate-only handle cleanup (`RUN-03`), canonical
  `processRuntime` test imports (`TEST-01`) and exact `XLNModule` alias
  (`API-01`) now have source/test evidence; the AST file/function ratchet closes
  `ARCH-02` and must be tightened to zero debt rather than reimplemented.
  The audit's 278-LOC deletion table is stale: `getAccountTimeoutStats`,
  `writeFrameDbPutsWithRetention`, `j-events-account-lookup.ts` and
  `getFirstSignerForEntity` are already absent, while the current dispute
  finalization scrubber, Hanko witness code and every exported Level helper
  have production or owning-test call sites. Do not delete those live paths.
  Recheck static imports, dynamic entrypoints, browser exports and owning tests
  immediately before any further deletion. Evidence at the reverified SHA:
  `bun run check` passed and isolated full browser E2E passed `125/125`; these
  prove the current baseline, not the still-open findings above. The concrete
  open fixes remain decomposed below so each gets its own L1 → L2 → L3 gate.
  A later full-E2E run exposed one additional durability bug not present in the
  audit: a derived `scheduledWake` could be written as pending WAL input and
  lose its process-local authorization on reload. The canonical durable
  mempool projection now removes derived wakes and orphaned timestamps while
  retaining their crontab source; L1 scheduled-wake tests and the exact
  BrainVault reload L2 are green. Keep this regression in the full gate.
  The later Kimi architecture/naming audit was rechecked on
  `main@fe533f375efe`: its remaining live findings are already tracked below
  (Entity-owned dispute-finality money mutation, explicit
  `RuntimeReplica`/`AccountReplica` envelopes, the Account-frame
  `decode*`/`isWellFormed*` validator pair, and a narrow Runtime facade).
  Do not resurrect its stale items: the `settle` AccountInput bypass,
  `addToAccountMempool`, `RuntimeSnapshot`, `EntityOutput`, and missing WAL
  rejection of routed local `AccountInput.txs` are already deleted or fenced
  with tests.
  The later Claude audit of dirty `main@c4f9fab62836` was reverified on current
  `main`: its typed Runtime-ingress provenance bypass, non-exhaustive Account
  commitment invalidation, and orphaned same-height collision harness are
  fixed with targeted evidence. Exact remote-input discard, exhaustive Account
  commitment invalidation, hot-path root cost and the SCC-size ratchet now
  have source/test evidence. Keep the remaining typed Runtime frame/live field
  ownership task below. Do not copy stale path counts or reintroduce a second
  audit backlog.
- [ ] Make the audit surface mechanically legible after the function split.
  Keep production runtime at zero explicit `any` and zero TypeScript
  suppressions; drive the exact `as unknown as` debt to zero through typed
  boundary decoders/adapters. The AST ratchet must reject every new occurrence
  and every increase. Decode untrusted WAL/P2P/RPC/LevelDB data exactly once,
  then pass canonical types through reducers instead of scattering defensive
  guards through trusted financial code.
  Delete rename-only import aliases where the canonical exported name can be
  used directly; retain namespace imports, `as const`, type assertions and
  genuine collision resolution because they are different language features.
  Remove duplicate constructors/policies/serializers only after proving one
  canonical owner, delete dead exports only after static and dynamic
  entrypoint/call-site checks, and add concise comments at every financial
  invariant, WAL boundary, adversarial-input boundary and intentionally
  non-obvious ordering rule. Comments must explain why the tempting alternative
  is unsafe rather than restating the code.
- [ ] Finish one canonical jurisdiction-event pipeline and make its trust
  boundaries mechanically visible:
  `transport log → JEventIngress → JEvent → JurisdictionEvent → certified
  JurisdictionEventBlock`. RPC, TRON and BrowserVM may differ only while
  decoding transport evidence; after that they must use the same ingress,
  relevance, fan-out, history and Runtime-input construction. Keep
  `AccountSettled` as the single explicit one-log-to-many-event projection,
  preserve `logIndex/eventIndex` ordering and dispute-finalization evidence,
  and fail loud on unknown or malformed financial events. Prove that no
  transport DTO can enter consensus directly and that required block/hash/tx
  coordinates cannot become `0`/`0x` defaults after the witnessed boundary.
- [ ] Delete the remaining jurisdiction-event representation and conversion
  debt. Derive decoder registry/type linkage from one event catalog only where
  this reduces net LOC. Every surviving `normalize*`, `decode*`, `to*Event*`
  and `from*Event*` must own a documented validation or trust transition.
  Remove `RecentJEvent` from live Runtime state once the rebuildable history
  view supplies the same receipt evidence without a second archive.
- [ ] Split `jadapter/helpers.ts` and `createRpcAdapter` by real I/O and failure
  boundaries, with no barrel or dependency-bag replacement. Canonical owners
  are receipt decode, event relevance/fan-out, certified history range,
  Runtime ingress, cursor/rewind, deployment, contract attachment, submission,
  receipt confirmation, watcher reconciliation and wallet writes. Delete
  duplicate gas/nonce/RPC-error policies and BrowserVM/RPC event logic as each
  owner is extracted. Record before/after LOC, converter count and import
  edges; require negative net LOC or a proven trust-boundary/type-safety gain.
  Keep `rpc-adapter.ts` below 3000 throughout and drive its exact oversized
  function allowances to zero.
- [ ] Replace technical-history top-level folders with an owner-first tree,
  preserving the distinct guarantees as named subfolders rather than unrelated
  roots: `storage/{wal,state,views,queries,recovery}`,
  `jurisdiction/{machine,adapter}`, `network/{p2p,relay}`,
  `api/{public,server,runtime}`, and `watchtower/push`. Eliminate singleton
  `state/` by moving Runtime construction under `runtime/`; move the single MPP
  module from `agent-payments/` to `protocol/payments/`; delete empty
  untracked `engine/` and `e2e/`. Perform path-only batches with exact export
  surface checks and no compatibility re-exports, then tighten the dependency
  and root-surface ratchets after every move.
- [ ] Normalize the three nested state-machine vocabularies (owner-approved)
  without pretending
  their consensus protocols are identical. Preferred names are `RuntimeState`,
  `EntityState`, `AccountState`; `RuntimeInput`, `EntityInput`, `AccountInput`;
  `RuntimeFrame`, `EntityFrame`, `AccountFrame`; and matching `*Output` types.
  The compile-checked migration from the historical `Env` and `AccountMachine`
  names is complete, including frontend and test consumers. Give each
  machine the same narrow façade and phase vocabulary (`admission`, `apply`,
  `frame`, `consensus`/`commit`, `output`, `state-root`) while keeping Runtime
  WAL, Entity validator certification and Account bilateral ACK semantics
  explicit. Do not introduce inheritance or a generic reducer that hides those
  different trust boundaries.
- [ ] Separate committed frame state from each replica envelope before
  optimizing clones. Target `RuntimeReplica = RuntimeState + one ingress
  queue + WAL/outbox/lifecycle`, `EntityReplica = EntityState + mempool +
  candidate/certificate`, and `AccountReplica = AccountState + mempool +
  pending bilateral candidate/ACK/resend metadata`. `*State` must contain only
  deterministic data committed by its corresponding frame; validator-local,
  transport, watchdog and retry fields belong to the envelope. First pin
  byte-identical roots, replay, pre-WAL failure and post-WAL recovery. Runtime
  may then use single-writer mutate+halt/reload instead of a full clone; Entity
  and Account must retain isolated candidates until their respective
  certificate or bilateral ACK commits them. Keep single-signer Entity on the
  same candidate pipeline with an immediate local certificate. Preserve the
  intentional parent commitment: EntityState binds the deterministic
  AccountReplica envelope (mempool, pending candidate and delivery state with
  post-commit Hankos stripped), while AccountStateRoot binds only bilateral
  committed state. Replace implicit field-deletion projections with two
  explicitly named byte-identical projections.
- [ ] Give every nested machine one explicit deterministic input boundary.
  `RuntimeInput` owns `RuntimeTx[]` plus routed Entity inputs; `EntityInput`
  owns `EntityTx[]` plus Entity-consensus evidence. `AccountInput` is the one
  Account boundary: its local `txs` branch carries `AccountTx[]` destined for
  a future Account frame, while its peer
  `frame/ack/frame_ack/dispute/reseal` branches carry bilateral
  consensus evidence. The `accountInput` EntityTx commits the exact child
  `AccountPeerInput`; Entity-owned financial transactions create the local
  `AccountInput.txs` branch. Both paths enter one `applyAccountInput`
  transition so Entity reducers never mutate an Account mempool directly.
  Do not serialize that deterministically derived local child input as an
  additional `EntityTx.accountInput`: the parent EntityTx already commits the
  instruction that produces it, while duplicating the child would change
  EntityFrame bytes and create two sources of truth. Add an explicit
  WAL/schema fence rejecting `EntityTx.accountInput.data.kind === 'txs'`,
  matching the existing TypeScript and P2P boundary.
  Validate pair endpoints, domain and watch seed before dispatching every
  AccountInput variant. Preflight a complete local `txs` batch and install it
  atomically so a rejected later transaction cannot leave earlier admission
  behind at the Account API boundary.
  Each replica transition
  returns deterministic outputs to its parent; only Runtime may interpret
  committed outputs as post-WAL external effects. Keep transaction order and
  multiplicity byte-identical, especially identical separately authorized
  payments, while lifecycle transactions retain exact-payload idempotency.
- [ ] Standardize transition result naming (owner-approved):
  `outputs` are deterministic messages to another state machine; `effects` are
  post-commit external I/O only; queued child-machine inputs must be named for
  their destination instead of the implementation detail `mempoolOps`.
  Entity reducers wrap local future-frame `AccountTx[]` in
  `AccountInput { kind: 'txs' }`; peer AccountInput variants remain exact
  bilateral protocol payloads.
  Account proposals never time out: once a Hanko leaves the replica, the
  signed proposal is final and non-negotiable. Lost delivery only resends the
  exact signed `AccountPeerInput`. A pending proposal may be rolled back only
  during deterministic same-height collision resolution: the valid LEFT frame
  wins, the losing pending transactions return to the Account mempool in their
  original order, and they are reapplied above the accepted frame. The winner
  never depends on wall time, retries, HTLC deadlines, dispute evidence or a
  settlement nonce: the protocol permits one proposal per side per height, and
  `Depository.sol` uses the same unconditional LEFT tie-break.
  Evaluate a small structural `Transition<State, Output, Effect>` result type,
  but adopt it only where it removes duplicate result shapes without weakening
  the Runtime/Entity/Account ownership boundary.
- [ ] Pin the financial and durability baselines before structural changes.
  Add byte-identical roots for payment/HTLC/settlement/rebalance, durable
  reliable-frontier assertions on both peers, rollback ordering, and measured
  clone/apply/WAL/dispatch p50/p95. Record the public `runtime.ts` export
  surface and always rebuild the browser bundle before browser evidence.
  Preserve explicit regressions proving that a queued writer rechecks sticky
  halt after waking, a post-WAL notification failure cannot downgrade a
  durable commit, and abort closes candidate-only storage handles without
  touching live handles.
- [ ] Remove all remaining ephemeral Account replica fields from
  `AccountState`. Move validation candidate/cache, mempool, pending frame,
  outbound ACK/resend
  and delivery metadata into `AccountReplica`; delete the exclusion lists only
  after old/new byte-identical Account roots and restart behavior are proven.
  Do not add a compatibility fallback: this is testnet, so make one canonical
  schema transition with explicit migration tooling if durable fixtures need
  conversion.
- [ ] Finish the canonical Activity projection and local crypto ownership.
  `EntityState.messages`, `batchHistory`, and the unwritten
  `accountInputQueue` are gone: text and J finality are certified frame events,
  durable history is read through the shared Activity panel, and no duplicate
  UI cache remains in consensus State. Complete the exact typed
  `ActivityEvent` projection for Entity, Account, and authenticated J events
  with deterministic event id, source machine/frame/hash/index, scopes, actor,
  kind, and payload. Keep the disposable LevelDB view exactly rebuildable from
  the authoritative Runtime WAL and certified child frames. Relocate
  hash-excluded `entityEncPrivKey` to validator-local `EntityReplica` storage
  only after dynamic/browser entrypoints, recovery hydration, and root fixtures
  prove its real ownership; use one testnet schema and no fallback reader.
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
- [ ] Finish canonical financial construction and naming. Empty Deltas now use
  the Account-owned constructor, hold fields are mandatory, and strict versus
  boolean Account-frame validation is named `decodeAccountFrame` versus
  `isWithinAccountFrameBounds`. Centralize the remaining settlement-Hanko
  projection and RuntimeState symbols. Keep exactly three semantic verb
  families: `decode*` for unknown/wire → typed and throw, `assert*` for a typed
  invariant and throw, and `is<Decision>*` for one boolean decision.
- [ ] Restore a structurally enforceable money boundary. Move finalized
  Account J-event settlement/dispute mutations out of `entity/tx/` and into
  Account-owned handlers; Entity may authenticate and route, but only Account
  code may change delta, collateral, holds or credit. This does not make
  dispute finality bilateral: the Account-owned J-finality handler is applied
  immediately and unilaterally from authenticated chain history, without an
  Account mempool, proposal, or peer ACK. The returning peer independently
  consumes the same finalized J-event and converges byte-identically. Preserve
  proof gating, cache invalidation and state roots with settlement/dispute
  tests, and add an ownership gate forbidding Entity/Runtime writes to Account
  money fields outside calls into Account-owned handlers.
- [ ] Turn Runtime execution into one visible pipeline:
  `take → validate/plan → mutate owned Runtime → WAL → dispatch`.
  Keep exactly one live `RuntimeReplica` mempool; `runtimeInput` names only the
  immutable input persisted in a committed frame, never a second live queue.
  Represent all frame disposition, rollback and reliable-delivery flags in one
  explicit `FrameExecutionState` instead of cross-stage locals or closures.
  Runtime is the sole proposer and writer, so never clone the full Runtime
  State. Validate every expected rejection before mutation; then mutate the
  owned State directly. Any exception or storage doubt after mutation makes
  the in-memory object unreadable: halt immediately and reload the last
  committed WAL frame. Never attempt in-memory rollback or soft repair.
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
  currently call P2P debug delivery from the working candidate; queue all
  network-visible diagnostics and flush them only after WAL commit. A rolled
  back frame may log locally but must be externally unobservable.
- [ ] Make candidate isolation explicit per nested machine instead of cloning
  the entire Runtime/Entity tree. Single-signer Entity execution mutates its
  Runtime-owned State directly and relies on the enclosing Runtime WAL:
  programming faults halt that Entity and reload its last durable state while
  unrelated Entities continue. Multi-signer Entity execution must keep
  `replica.state` certified until Hanko. Keep speculative execution exclusively
  in the canonical `EntityReplica.candidate` phase; storage projections, API, UI,
  routing and capacity checks must never treat it as certified. Replace the
  full Entity clone used to build that candidate with a touched-only shell:
  clone each changed small Account and only changed Entity/orderbook Map keys,
  while untouched data references the immutable certified State. While locked,
  accept only consensus progress for that proposal; never write candidate
  Account/Entity frames to certified history or release financial outputs.
  Matching quorum Hanko promotes the already-executed candidate without
  re-execution. Root mismatch or certified timeout discards the candidate and
  advances the consensus view; unknown damage halts only that Entity and reloads
  its last certified frame. Persist a signing lock in every Runtime WAL frame
  that may dispatch a local precommit, before that signature becomes externally
  visible, so restart cannot double-sign. Validator removal remains governance.
  Happy-path work must be O(touched state), never O(total Accounts/orderbook),
  while unrelated Entities continue. Account remains
  the small bilateral transaction boundary and keeps a full isolated clone. Pin all four policies with
  characterization tests, perf budgets (clone bytes/reducer/WAL latency), and
  a gate forbidding reintroduction of full Runtime or single-signer Entity
  clones.
- [ ] Make post-state Runtime ingress rejection explicit and deterministic.
  Inputs admitted against frame H may become stale after the single writer
  commits H+1. Classify expected authenticated nonce/board/order conflicts as
  an explicit terminal protocol outcome, distinct from malformed ingress,
  invariant faults and storage failure; consume the exact stale origin once
  without halting Runtime. Add queued-writer stale-input and board-rotation
  regressions. Malformed remote discard and mixed-batch retention are already
  pinned and must remain unchanged.
- [ ] Split remaining god-functions by protocol phase and failure boundary:
  `applyEntityInput`, `applyAccountInput`, Runtime scheduler/transport/storage,
  and RPC submit/watch/receipt. Target pure helpers below 50 lines,
  coordinators below 100–150 lines, and every file below 3000 lines. After the
  pipeline, collapse DI factories that add navigation
  without providing a real swappable boundary. The R/E/A gate is already at
  zero functions over 100 lines. The production ratchet now owns 19 exact
  allowances over 150 lines and rejects every new/growing coordinator plus
  every file over 3000 lines; delete each allowance with its verified split.
  Start with
  `jadapter/rpc-adapter.ts`,
  `orchestrator/mm-node-run.ts`, `storage/runtime-storage.ts`,
  `orchestrator/hub-node.ts`, `recovery/restore.ts` and `storage/index.ts`;
  split by lifecycle/ownership boundary, not arbitrary line ranges, and lower
  the exact allowance after every verified extraction.
- [ ] Enforce an acyclic browser-safe core dependency graph. Keep cloning,
  codecs and state helpers as leaf modules that never import reducers,
  Runtime routing or chain adapters; add a cycle budget that fails on any new
  cycle crossing Runtime/Entity/Account/J boundaries. Extend the AST gate with
  a value-import Tarjan SCC ratchet seeded from the current verified maximum,
  then drive it to one while reverse imports are removed; a folder-direction
  allowlist alone does not see the current Account/Orderbook/Entity cycle.
  Execute SHA-256,
  proposal construction and one Account open from the actual browser bundle,
  not only Bun source imports. Programming faults such as `TypeError` must
  preserve their source stack and halt, never be relabelled as rejected input.
  Remove confirmed Account→Entity/Runtime ownership imports by moving pair
  ordering into a neutral protocol module, moving graph-wide solvency
  inspection under Runtime audit, and injecting signer/history/effect
  dependencies into Account consensus. Entity may return deterministic
  storage/effect descriptions but must not import Runtime mutation helpers.
- [ ] Remove only call-site-proven dead code in small module-owned batches.
  Reverify dynamic imports, scenario/CLI entrypoints and browser API first;
  `runNumberedRegistrationIntent` is currently live scenario infrastructure,
  not dead code. Delete proven topology, ID/hash-ladder, validation/logger,
  wallet/helper, retention/hook, lookup/barrel and rename-only orphans.
  The old audit's named deletion batch has been exhausted or disproved on the
  current tree; discover the next candidates from current call sites instead
  of carrying that stale list forward. Reverify and delete dead
  `RuntimeSnapshot`, zombie `EntityOutput`, and zero-call-site
  tx/financial/hook/barrel exports. Do not invent empty
  `RuntimeOutput` or `AccountOutput` aliases merely for naming symmetry;
  derive output unions only from real reducer results. Public API removals
  require an explicit compatibility decision.
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
- [ ] Parse every chain-supplied Account/J nonce through one safe boundary
  before any mutation. Remove direct `Number(uint256)` conversions in dispute
  start/finality and choose one canonical nonce representation that cannot
  round `9007199254740993` to `9007199254740992`; prove malformed/oversized
  events leave Account state unchanged.
- [ ] Make hub rebalance scheduling fail before money mutation on every
  cross-map inconsistency. Preflight fee metadata, Delta presence, reserve
  capacity and all selected J-batch operations before changing the draft or
  submission markers; missing state and batch construction errors must abort
  the isolated frame instead of logging `continue` after a prepaid request.
  Prove rollback leaves fee, request, draft and Account roots byte-identical.
- [ ] Make the directory hierarchy match the three nested state machines only
  after semantic diffs are green. Keep the stable root `runtime/runtime.ts`
  browser facade; place Runtime frame transition/mempool/transaction/lifecycle
  under `runtime/runtime/frame/` and reliable delivery/output/J submission
  under `runtime/runtime/delivery/`. Preserve the exact export surface.
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

- [ ] Make off-chain faucet admission durable and idempotent. Require a client
  idempotency key bound to the exact payload, persist the admission result
  before returning `200 queued`, and prove lost-response retry plus process
  crash/restart cannot enqueue a second direct payment.
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
