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
  Drive the AST-ratcheted reverse-import debt to zero: lower Account code must
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
- [ ] Make the audit surface mechanically legible after the function split.
  Keep production runtime at zero explicit `any`; drive the exact
  `as unknown as` debt and TypeScript suppression debt to zero through typed
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
- [ ] Remove ephemeral Account replica fields from `AccountState`, starting
  with `clonedForValidation`. It is currently kept out of consensus and
  persistence by independent name-based exclusions in clone, serialization,
  canonical hashing, projections, storage typing and Entity state-root code.
  Move validation candidate/cache, mempool, pending frame, outbound ACK/resend
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
  removed. The user-facing Activity stream contains committed facts only;
  rejected/quarantined inputs belong to a separate Operations/Debug journal.
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
- [ ] Canonicalize financial construction and naming. Make hold fields
  mandatory, build every empty Delta through one Account-owned constructor,
  and prove identical keys/roots across add-delta, J-settlement and projection.
  **Done:** renamed the strict wire decoder to `decodeRoutedEntityInput` and
  the soft consensus predicate to `isEntityInputWellFormed`; reducer outputs
  decode through `decodeRoutedEntityOutput` because Output is a direction, not
  a duplicate wire type. Next, centralize
  settlement-Hanko projection and RuntimeState symbols. Apply the same
  `decode/assert` versus `isWellFormed/isProposable` distinction to twin
  Account-frame validators; identical names must not hide throwing schema
  validation versus a soft consensus predicate. Use exactly three semantic
  verb families: `decode*` for unknown/wire → typed and throw, `assert*` for a
  typed invariant and throw, and `is<Decision>*` for a boolean decision.
  Rename the throwing Account-frame decoder to `decodeAccountFrame` and the
  bounded consensus predicate to `isWithinAccountFrameBounds`; if a predicate
  cannot be named for one decision, split its grab-bag checks instead of
  calling it generically `validate*`.
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
  `take → validate/plan → isolated RJEA apply → WAL → install → dispatch`.
  Keep exactly one live `RuntimeReplica` mempool; `runtimeInput` names only the
  immutable input persisted in a committed frame, never a second live queue.
  Represent all frame disposition, rollback and reliable-delivery flags in one
  explicit `FrameExecutionState` instead of cross-stage locals or closures.
  Extract transaction, commit, rollback and dispatch modules; keep
  `runtime/core.ts` a short composition root with no alternate commit path.
  Precompute every throwing assertion before install; any doubt after WAL
  halts and reloads the durable frame. Operational notifications happen only
  after the durable result is fixed and can report failure but never reclassify
  or roll back that result. `env.warn`, `env.error` and special info diagnostics
  currently call P2P debug delivery from the working candidate; queue all
  network-visible diagnostics and flush them only after WAL commit. A rolled
  back frame may log locally but must be externally unobservable.
- [ ] Make post-state Runtime ingress rejection explicit and deterministic.
  Inputs admitted against frame H may become stale after the single writer
  commits H+1; classify authenticated terminal protocol rejection separately
  from invariant/storage failure, consume or quarantine it exactly once, and
  never turn an expected nonce/board/order conflict into a global Runtime
  halt. Keep failures loud and add queued-writer stale-input/rotation tests.
- [ ] Split remaining god-functions by protocol phase and failure boundary:
  `applyEntityInput`, `applyAccountInput`, Runtime scheduler/transport/storage,
  and RPC submit/watch/receipt. Target pure helpers below 50 lines,
  coordinators below 100–150 lines, and every file below 3000 lines. After the
  pipeline, collapse DI factories that add navigation
  without providing a real swappable boundary. The R/E/A gate is already at
  zero functions over 100 lines. The production ratchet now owns 52 exact
  allowances over 150 lines and rejects every new/growing coordinator plus
  every file over 3000 lines; delete each allowance with its verified split.
  Start with
  `jadapter/rpc-adapter.ts`,
  `orchestrator/mm-node-run.ts`, `persistence/runtime-storage.ts`,
  `orchestrator/hub-node.ts`, `recovery/restore.ts` and `storage/index.ts`;
  split by lifecycle/ownership boundary, not arbitrary line ranges, and lower
  the exact allowance after every verified extraction.
- [ ] Enforce an acyclic browser-safe core dependency graph. Keep cloning,
  codecs and state helpers as leaf modules that never import reducers,
  Runtime routing or chain adapters; add a cycle budget that fails on any new
  cycle crossing Runtime/Entity/Account/J boundaries. Execute SHA-256,
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
  10k, 100k, and 1M accounts before claiming a path to 10M accounts/10k TPS;
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
- [ ] Replace unchecked `JSON.parse(...) as Stored*` reads in the watchtower
  LevelDB store with one strict decoder per persisted schema.
  Reject malformed records loudly with the key and schema name, never coerce
  corrupt financial-protection metadata to defaults, and prove behavior with
  real LevelDB corruption/reopen tests. Ship each schema boundary separately;
  do not add legacy or fallback decoders.
- [ ] Add one real Anvil contract-event dispute E2E after payment, HTLC,
  same-J/cross-J swap and pull state. Exercise malformed/oversized optional
  transformer arguments, compare final Depository reserves/debts to the
  canonical Runtime preview, and SIGKILL at WAL-before-dispatch and
  dispatch-before-receipt without double application.
- [ ] Profile the production bootstrap and growing-hub frame path locally.
  Remove only measured full scans/clones/duplicate crypto; publish deterministic
  1/1,000-tx and growing-hub median/p95/MAD budgets from a clean Bun cache.
  Measure the duplicate Account wake scan, per-frame verified-profile clone and
  repeated cross-J preview application; replace them only with dirty/versioned
  indexes or structural preflight proven byte-identical. The first indexes are
  one ephemeral `proposableAccountKeys` queue and a canonical
  `(entityId, signerId) → replicaKey` map rebuilt on restore/import. Record
  `frameCloneMs`, cloned replica/account/profile counts, estimated cloned bytes
  and cross-J preview clone time. A frame touching one account must not scale
  linearly when untouched accounts grow from 10,000 to 100,000.
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
