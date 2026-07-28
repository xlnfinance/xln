# xln mainnet TODO

This is the only live TODO/NEXT file and the active blocker list for deploying
code trusted with real funds. It contains launch work only, ordered from
fastest proof/fix to the hardest external gate. Completed work is deleted;
long-term work belongs in `docs/roadmap.md`, and permanent rules belong in
`docs/mainnet-engineering-principles.md`.

## 1. Core simplification and human auditability — P0/P1, owner-approved

- [ ] Close the still-live findings from the GPT audit of
  `main@fddcac8bab9420f48168b0453cc05419f858f392`, reverified against
  `main@5e30bcf47` instead of copying stale line numbers. Current-code inspection
  confirms the R→C duplicate lifecycle (`FIN-01/02`), unsafe dispute
  `uint256 → Number` conversion (`FIN-03`), fail-open rebalance construction
  (`FIN-04`), non-durable faucet admission (`SRV-01`), misplaced Account money
  mutation (`ARCH-01`) and duplicate/inexact UI money models (`UI-01`).
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
  immediately before any further deletion. The concrete open fixes remain
  decomposed below so each gets its own L1 → L2 → L3 gate.
- [ ] Pass the human-audit completion gate for the three nested state
  machines. Baseline on `main@404851e82`: 35 functions over 150 lines and 89
  over 100 lines under `runtime/runtime`, `runtime/entity` and
  `runtime/account`. Reduce every coordinator to at most 150 lines and every
  pure/helper function to at most 100 lines, with no file above 3000 lines;
  `check:state-machine-size` now ratchets the current debt at 25 functions over
  150 lines and 79 over 100, rejects any new/growing allowance and rejects
  files over 3000 lines. Keep reducing both counts to zero, deleting each exact
  allowance as its function is split.
  Keep Runtime-machine logic under `runtime/runtime/`, Entity-machine logic
  under `runtime/entity/`, and Account money/consensus logic under
  `runtime/account/`; adapters, storage, transport, UI and QA remain separate
  infrastructure rather than being mislabeled as a state machine. The current
  first structural targets are:
  same/cross-J orderbook matching (485/468),
  `processDueHooks` (293),
  `applyEntityFrame` (286),
  `applyAccountTxMutation` (265),
  `submitRuntimeJOutbox` (259),
  `applyFinalizedJEvent`/`applyEntityTxsInOrder` (257/255),
  `handleCrossSwapFillAck` (255),
  and Runtime output plan/dispatch (189/201).
  Each split must follow protocol phase, owner and failure boundary—not
  arbitrary line chunks—and preserve byte-identical roots, failures and
  ordering through characterization tests.
- [ ] Make the audit surface mechanically legible after the function split.
  Delete rename-only import aliases where the canonical exported name can be
  used directly; retain namespace imports, `as const`, type assertions and
  genuine collision resolution because they are different language features.
  Remove duplicate constructors/policies/serializers only after proving one
  canonical owner, delete dead exports only after static and dynamic
  entrypoint/call-site checks, and add concise comments at every financial
  invariant, WAL boundary, adversarial-input boundary and intentionally
  non-obvious ordering rule. Comments must explain why the tempting alternative
  is unsafe rather than restating the code.
- [ ] Pin the financial and durability baselines before structural changes.
  Add byte-identical roots for payment/HTLC/settlement/rebalance, durable
  reliable-frontier assertions on both peers, rollback ordering, and measured
  clone/apply/WAL/dispatch p50/p95. Record the public `runtime.ts` export
  surface and always rebuild the browser bundle before browser evidence.
  Preserve explicit regressions proving that a queued writer rechecks sticky
  halt after waking, a post-WAL notification failure cannot downgrade a
  durable commit, and abort closes candidate-only storage handles without
  touching live handles.
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
  Rename the soft consensus predicate and strict ingress assertion so two
  operations are not both called `validateEntityInput`; centralize
  settlement-Hanko projection and Runtime Env symbols.
- [ ] Restore a structurally enforceable money boundary. Move finalized
  Account J-event settlement/dispute mutations out of `entity/tx/` and into
  Account-owned handlers; Entity may authenticate and route, but only Account
  code may change delta, collateral, holds or credit. Preserve proof gating,
  cache invalidation and state roots with settlement/dispute tests.
- [ ] Turn Runtime execution into one visible pipeline:
  `take → validate/plan → isolated RJEA apply → WAL → install → dispatch`.
  Keep exactly one live `Env.runtimeMempool`; `runtimeInput` names only the
  immutable input persisted in a committed frame, never a second live queue.
  Represent all frame disposition, rollback and reliable-delivery flags in one
  explicit `FrameExecutionState` instead of cross-stage locals or closures.
  Extract transaction, commit, rollback and dispatch modules; keep
  `runtime/core.ts` a short composition root with no alternate commit path.
  Precompute every throwing assertion before install; any doubt after WAL
  halts and reloads the durable frame. Operational notifications happen only
  after the durable result is fixed and can report failure but never reclassify
  or roll back that result.
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
  without providing a real swappable boundary. Add an AST gate for function
  budgets so future 600–2800-line coordinators cannot pass a file-only limit.
- [ ] Enforce an acyclic browser-safe core dependency graph. Keep cloning,
  codecs and state helpers as leaf modules that never import reducers,
  Runtime routing or chain adapters; add a cycle budget that fails on any new
  cycle crossing Runtime/Entity/Account/J boundaries. Execute SHA-256,
  proposal construction and one Account open from the actual browser bundle,
  not only Bun source imports. Programming faults such as `TypeError` must
  preserve their source stack and halt, never be relabelled as rejected input.
- [ ] Remove only call-site-proven dead code in small module-owned batches.
  Reverify dynamic imports, scenario/CLI entrypoints and browser API first;
  `runNumberedRegistrationIntent` is currently live scenario infrastructure,
  not dead code. Delete proven topology, ID/hash-ladder, validation/logger,
  wallet/helper, retention/hook, lookup/barrel and rename-only orphans.
  The old audit's named deletion batch has been exhausted or disproved on the
  current tree; discover the next candidates from current call sites instead
  of carrying that stale list forward. Public API removals require an explicit
  compatibility decision.
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

## 2. Contract boundedness — P0/P1, owner-approved
- [ ] Remove the remaining proven pre-mainnet compatibility ABI/state:
  migrate V1 settlement `diffsToOps` and `position.xlnomy`, then delete unused
  contract `resolveEntityId` and ineffective `hashToBlock/cleanSecret`. Use one
  schema/ABI change with no legacy decoder or fallback. `Env.browserVM` is
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
