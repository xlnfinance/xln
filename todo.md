# XLN TODO

Last updated: 2026-07-08

This is the only live TODO/NEXT file for the repository. Older planning notes
under `docs/archive/` are historical evidence, not active backlog. When this
file and older docs disagree, prefer code and tests first, then this file.

## Mainnet Deferred

- [ ] P0 security: move signing behind a remote signer/HSM boundary and keep raw
  runtime signing seed material out of persisted artifacts and long-running
  runtime process memory. Deferred by user on 2026-07-08 while non-signature
  mainnet blockers are closed first.

## Closed Or Removed

- Removed the stale testnet handoff whose old faucet/runtime notes were from a
  retired stack and are not active release blockers.
- Removed the broken root `next.md` symlink to a non-existent planning path.
- Removed duplicated live TODO/NEXT pages from frontend static docs. The app
  should not serve stale February/May planning snapshots as current status.
- Merged `ai/todo.md` into this file as auxiliary work, then removed the
  separate AI TODO source.
- Removed old agent scratchpads and top-level audit drafts from the live tree.
  Current consensus/signature/contract concerns are represented below instead
  of scattered through dated request documents.
- Closed default test-artifact cleanup for test pipelines: runners remove old
  generated test output before new runs unless `--keep-test-artifacts`,
  `--no-cleanup`, or `XLN_KEEP_TEST_ARTIFACTS` says otherwise, and the default
  workspace budget gate is 50GiB.
- Archived the stale admin/QA backlog from `docs/todo.md` to
  `docs/archive/planning/todo-2026-06-25-admin-qa.md`; `bun run check`
  now fails if another non-archived `todo.md`/`next.md` appears outside the
  root live backlog.
- Removed obsolete jurisdiction contract-size consultation notes that referred
  to pre-refactor `Depository.sol` structure.
- Closed as `v0.1.5` work: official same-origin watchtower endpoint, scheduler,
  public sweep closure, encrypted active tower remedy payloads, body caps,
  health stats caching, tower GC, runtime backup send barrier, browser recovery
  restart survival, and prod health recovery.
- Confirmed in the `0.1.5` release pass: `bun run gate:ci`,
  `bun run test:e2e:full`, `bun run test:e2e:prod:payment`, and
  `bun run prod:health` passed.
- Closed RPC J-replica state commitment placeholder: RPC/external
  jurisdictions now expose an explicit unavailable root instead of fake zero
  bytes; BrowserVM replicas must provide a real captured root.
- Closed destructive reset guardrails: mesh `/api/reset` now requires explicit
  destructive confirmation and token protection for public binds; browser
  `/resetdb` requires a nonce-cookie handshake, and restore/version failures no
  longer wipe local client state automatically.
- Closed persistence inspect/repair operator path: `bun run debug:persistence`
  inspects frame DB, snapshots, WAL tail, recovery bundles, and tower receipts;
  `--strict` turns warnings/critical findings into non-zero exit codes, and the
  command is inspect-only with explicit repair guidance instead of automatic
  persistence mutation.
- Closed the current RPC/JAdapter release blocker: ethers provider cache/batch
  behavior is disabled for XLN RPC providers, local Anvil latest-state
  `staticCall` snapshot races are tolerated only after successful gas estimate
  on dev chains, and fatal-log scanning no longer treats that handled dev race
  as a protocol failure.
- Confirmed on the current release line: `bun run gate:release` passed,
  production health smoke returned healthy, and a release soak was manually
  stopped after 13 complete `gate:ci + hub10k` iterations with exit code `0`.
- Added mainnet-preflight gate plan and reduced the capped-testnet executable
  soak policy from 24 hours to 1 hour for faster local release loops. The
  uncapped real-funds bar can still require a longer soak before launch.
- Added the dev control-panel banner, QA verdict explanation panel, browser-side
  remote-runtime import diagnostics, and admin cockpit selftest assertions.
- Aligned capped-testnet soak execution with the one-hour policy:
  `soak:capped-testnet`, `MAINNET_GATE.soakMinutes`, the capped policy file,
  and capped-gate tests now agree on 60 minutes.
- Refreshed current mainnet/security status docs and re-ran
  `bun run security:audit-pack`; this prepares the internal audit handoff pack
  but does not replace an independent external audit.
- Published the GitHub Release object for pushed tag `v0.1.5`:
  https://github.com/xlnfinance/xln/releases/tag/v0.1.5. The release is marked
  prerelease and explicitly says it is public-testnet/pre-mainnet evidence, not
  mainnet approval.

## P0 - Release And Mainnet Readiness

### Current Runtime-Client Audit Closure

Status markers in this block are live. Do not mark an item closed without a
regression test or executable gate that would fail if the issue returns.

- [x] **P0: deterministic release gate exits cleanly.**
  - Current failure: `bun run check:determinism` reaches PASS summary but keeps
    watcher/anvil handles alive and must be stopped manually.
  - Exit: command exits `0` on its own, with a regression guard for cleanup.
  - Closed: scenario cleanup stops runtime loop, waits for in-flight watcher
    polls, shuts down managed Anvil, and `check-determinism` exits `0` on
    success. Guard: `runtime/__tests__/determinism-cleanup.test.ts`.

- [x] **P1: remote admin actions are projection/command based.**
  - Remove remaining embedded `Env` requirements from reserve-to-external,
    external-to-reserve, debt enforcement, and pending batch admin actions.
  - Exit: writable remote admin surfaces build and submit `RuntimeInput`
    through shared command paths without `requireRuntimeEnv`.
  - Closed: move draft and pending-batch actions resolve signer from
    projection-aware command context, and debt enforcement builds `jInputs`
    from projected jurisdiction data. Guards:
    `tests/frontend/runtime-command-bus.test.ts`,
    `tests/frontend/pending-batch-actions.test.ts`, and
    `tests/frontend/debt-enforcement-command.test.ts`.

- [x] **P1: no arbitrary direct adapter read escape hatch.**
  - Replace raw `runtimeAdapterRead`/debug `read(path)` with typed
    `RuntimeQueryClient` reads, including receipt status.
  - Exit: frontend grep/test proves UI/debug surfaces cannot issue arbitrary
    adapter read paths.
  - Closed: `RuntimeQueryClient.readReceiptStatus()` owns receipt reads,
    `window.__xlnRuntimeAdapter` exposes typed `query.*` helpers only, and
    radapter e2e probes use that typed surface. Guard:
    `tests/frontend/runtime-query-client.test.ts`.

- [x] **P2: remove or rename legacy `isolatedEnv` public surface.**
  - `window.isolatedEnv` and `isolatedEnv` prop names are legacy debug names and
    conflict with the RuntimeView ownership model.
  - Exit: app code uses a typed live-runtime snapshot/debug surface name; E2E
    helpers are updated or bridged only through explicit compatibility tests.
  - Closed: `frontend/src/lib/view` now uses `runtimeFrame*` store names and
    publishes local debug state through `window.__xln.liveRuntimeSnapshot` /
    `window.__xln.publishLiveRuntimeSnapshot`, with no top-level
    `window.isolatedEnv` compatibility surface. Guard:
    `tests/frontend/runtime-store-hot-swap.test.ts`.

- [x] **P2: EntityWorkspace API is projection-first.**
  - Remove `Env | EnvSnapshot` ownership from the workspace boundary once the
    action modules above no longer need live embedded env.
  - Exit: workspace tests fail on `Env | EnvSnapshot` props in the entity shell.
  - Closed: `EntityWorkspace.svelte` no longer exports separate Env/history/live
    props and its projection model file does not import full Env. The remaining
    embedded action passthrough is isolated as `EntityWorkspaceRuntimeFrameContext`
    for `EntityPanelTabs`. Guard: `tests/frontend/entity-workspace.test.ts`.

### Current Runtime-Client Cleanup Pass

Status markers in this block track the audit items that reduce runtime-client
surface area. Prefer deletion or stricter boundaries over compatibility shims.

- [x] **P1: radapter current head preserves persisted checkpoints.**
  - Failure: browser e2e saw `latestSnapshotHeight=0` after remote admin
    command even though H1 persisted a ready snapshot.
  - Exit: stale persisted heads keep snapshot cadence/checkpoint metadata while
    live runtime height advances.
  - Closed: `readBestHead()` now merges stale persisted snapshot metadata with
    live height instead of discarding storage head entirely. Guards:
    `runtime/__tests__/radapter.test.ts` and focused remote browser e2e.

- [x] **P1: gate debug globals consistently.**
  - Remove ungated `window.__xln_env` / `window.__xln_instance` writes or route
    them through the localhost-only debug surface helper.
  - Exit: non-localhost console cannot mutate live embedded runtime state via
    global Env handles.
  - Closed: both legacy names are localhost-only `registerDebugSurface` getters
    under `window.__xln`; direct global assignment is source-guarded by
    `tests/frontend/runtime-store-hot-swap.test.ts`.

- [x] **P1: remove dead arbitrary read exports.**
  - Delete unused `runtimeQueryRead` and `createRuntimeReadStore`; keep generic
    adapter reads private inside `RuntimeQueryClient`.
  - Exit: only typed query helpers are exported/used by frontend surfaces.
  - Closed: `RuntimeQueryClient.read/cachedRead` are private, no public
    `runtimeQueryRead` or `createRuntimeReadStore` remains. Guard:
    `tests/frontend/runtime-query-client.test.ts`.

- [x] **P1: share debt enforcement command builder with runtime.**
  - Delete frontend duplicate `debt-enforcement-command.ts` protocol shape.
  - Exit: frontend and embedded Env path use one pure runtime builder.
  - Closed: pure builder lives in `runtime/debt-enforcement-command.ts`;
    frontend and env-aware runtime wrapper call the same function. Guards:
    `tests/frontend/debt-enforcement-command.test.ts`,
    `tests/frontend/runtime-command-bus.test.ts`, and
    `runtime/__tests__/multi-jurisdiction-entity.test.ts`.

- [x] **P2: finish `isolatedRevision` naming cleanup.**
  - Rename remaining `isolatedRevision` prop/store names to
    `runtimeFrameRevision`.
  - Exit: source grep only finds archived/test allowlist references for
    `isolated[A-Z]`.
  - Closed: `UserModePanel` and `View` use `runtimeFrameRevision`; legacy
    isolated names are source-guarded by
    `tests/frontend/runtime-store-hot-swap.test.ts`.

1. **Finish release-duration soak before any mainnet-candidate claim.**
   - Already passed for `0.1.5`: `gate:ci`, full browser E2E, prod payment E2E,
     prod health.
   - Passed on current `main`: `bun run gate:release`.
   - Partial evidence on current `main`: 13 full `bun run soak:release`
     iterations (`gate:ci` plus `hub10k`) passed before the run was stopped
     manually for time.
   - Still needed for a mainnet candidate: a complete uninterrupted
     one-hour `bun runtime/scripts/run-mainnet-preflight-gate.ts --include-soak`
     from a clean tree.

2. **Make real mainnet ops explicit.**
   - Chain/RPC endpoints selected and documented.
   - Funded operator/tower accounts and gas policy documented.
   - Backup/restore and incident drills run against production-like data.
   - Monitoring and alert thresholds cover runtime, relay, storage, market
     maker, and watchtower.

3. **Keep admin cockpit green before handoff.**
   - Exit: focused QA cockpit e2e covers verdict explanations, four user-story
     videos, screenshot gallery/slideshow, run ledger, history DB controls, and
     read/admin disabled states.
   - Exit: remote-runtime bulk import reports every checked row, imports
     successful rows, and shows retryable diagnostics for failed rows.

4. **External audit handoff.**
   - Refresh `docs/security/external-audit-brief.md`.
   - Produce the current audit pack with `bun run security:audit-pack`.
   - Do not treat internal E2E success as a substitute for audit on real funds.

## P1 - Protocol And Runtime

1. **Peer State Refresh (PSR).**
   - Define and implement the live peer refresh wire flow from
     `docs/recovery-watchtower-protocol.md`.
   - Exit: a wiped client can recover from honest peer/hub state even when the
     tower is unavailable.

2. **Recovery coverage UX and receipts.**
   - Show local, tower backup, delayed-last-resort, and peer-refresh coverage
     per runtime/account.
   - Surface last successful tower upload height and failure reason.
   - Partial: peer-refresh coverage now surfaces persisted typed peer discovery
     failure category/code for empty, transient, and contradictory PSR outcomes.
   - Partial: onboarding recovery check now renders typed tower/peer discovery
     failure labels instead of hiding them behind a warning count only.

3. **Typed failure taxonomy across runtime and ops.**
   - Split failures into explicit categories instead of treating every loud
     error as the same kind of stop.
   - Baseline categories: `Contradiction` is fatal and halts,
     `ExpectedEmpty` is normal empty state, `TransientRace` retries with a
     bounded TTL and only becomes fatal after expiry.
   - Partial: recovery discovery now records structured tower/peer failures
     with `ExpectedEmpty`, `TransientRace`, and `Contradiction` categories while
     keeping legacy warning strings for non-empty failures only.
   - Partial: runtime import readiness now returns typed `failure` metadata
     (`category`, `code`, `retryable`, `fatal`) instead of forcing health/API
     callers to parse `reason` strings.
   - Partial: aggregated runtime health now includes typed `failures[]` beside
     legacy `degraded[]`, and public health redaction exposes safe failure
     codes without leaking internal messages.
   - Partial: orchestrator transport/proxy failures now include stable `code`,
     `category`, `retryable`, `fatal`, and `failure` metadata while preserving
     legacy `error` text and HTTP status.
   - Partial: offchain faucet rejection paths now include typed failure metadata
     for empty hubs, missing accounts, capacity limits, validation errors, and
     runtime admission failures.
   - Partial: reserve faucet rejection paths now share the faucet failure helper
     and expose typed metadata for missing adapters, invalid tokens, empty hubs,
     insufficient reserves, batch timeouts, and missing reserve evidence.
   - Partial: bootstrap timeline stages now expose typed per-stage `failure`
     metadata, with public health redaction preserving codes/categories while
     hiding internal messages.
   - Partial: aggregated market-maker health now exposes a typed component
     `failure` for inactive child process, missing child health, startup phase,
     hub depth, hub count, and cross-route readiness; public health redaction
     keeps only safe code/category/retryability metadata.
   - Partial: settlement/J-batch submission failures now classify transient RPC
     failures separately from terminal protocol failures on the existing
     `sentBatch` lifecycle metadata.
   - Partial: prod health smoke and e2e baseline readiness now treat typed
     `fatal:true` health failures as authoritative readiness blockers while
     preserving legacy `degraded[]` checks.
   - Apply first to transport, bootstrap, faucet/seed funding, market maker,
     settlement batching, and health readiness before touching consensus hot
     paths.
   - Exit: orchestrator/health can explain why a component is degraded without
     guessing from logs or swallowing real contradictions.

4. **Consensus and Hanko production review.**
   - Re-check current account commit semantics, settlement hankos,
     chain/contract domain separation, J-event finalization, and mempoolOps
     against the current code instead of old audit snapshots.

5. **Contract governance/access-control scan.**
   - Re-run a current pass over `EntityProvider`/`Depository` for permission
     checks, gas bounds, and public debug surfaces before external audit.

6. **One delivery abstraction.**
   - Collapse direct-vs-relay send logic, pending queues, TTLs, retries, and
     ACK interpretation into one transport boundary.
   - Relay is the official baseline; direct delivery is an opportunistic fast
     path with the same bounded queue semantics.
   - Partial: relay/direct/local delivery debug events now get one typed
     `delivery` result with retry/fatal/terminal semantics instead of requiring
     callers to parse status/reason strings.
   - Partial: health relay timeline severity now reads `delivery` metadata
     first and only falls back to legacy status strings for old events.
   - Partial: P2P entity-input send, pending flush, and public entity-input
     dispatch now use the same typed delivery result shape; boolean remains
     only on raw socket transport send.
   - Partial: P2P pending flush retry/drop decisions now use typed
     `delivery.terminal` and emit typed delivery debug events for retryable and
     terminal failures.
   - Partial: P2P pending TTL expiry now emits the same typed terminal
     `delivery` metadata before dropping stale queued entity inputs.
   - Partial: public runtime `sendEntityInput`/routing results now return the
     typed `delivery` result without legacy boolean summary fields.
   - Partial: process-local direct entity dispatch is now typed-only at the
     routing boundary; legacy boolean returns fail fast instead of falling
     through to P2P.
   - Partial: relay-socket, hub-node, and market-maker direct dispatch
     implementations now return explicit `DeliveryResult`.
   - Partial: direct runtime websocket route now exposes typed
     `sendEntityInputDelivery()` instead of a high-level boolean send wrapper;
     hub and market-maker nodes use that result directly.
   - Partial: `RuntimeWsClient` entity-input send is now explicitly named
     `sendEntityInputRaw()` and is only consumed inside P2P's typed delivery
     adapter.
   - Partial: delivery validation, delivered detection, and retry retention now
     live in shared `delivery-result` helpers instead of per-call-site logic.
   - Partial: RuntimeP2P now exposes typed `enqueueEntityInputDelivery()`;
     `dispatchEntityOutputs()` requires it, with no high-level boolean wrapper.
   - Partial: route dispatch now uses shared delivered-check helpers for direct
     fast-path acceptance and P2P hard-delivery assertions instead of raw
     `outcome` comparisons.
   - Partial: P2P pending flush now gets retry/drop event disposition from the
     shared delivery helper instead of mapping `terminal` to event level/code
     locally.
   - Partial: process-local relay direct dispatch now treats stale sockets and
     failed `send()` results as typed deferred delivery instead of claiming
     delivery, and its direct packet id comes from relay store sequencing rather
     than wall-clock/random data.
   - Partial: relay router and process-local relay direct dispatch now share
     one relay send-result predicate for `false` and negative native send
     return values.
   - Partial: P2P no-pubkey debug and gossip-refresh decisions now read
     `delivery.code` instead of reparsing thrown error text at call sites.
   - Partial: P2P pending queue flush now produces one typed per-entry
     flush result (`delivery`, retain/drop, optional event, gossip refresh)
     before mutating the queue.
   - Partial: relay router entity-input admission rejects and local-delivery
     failures now attach typed `delivery` metadata while preserving existing
     debug event status fields.
   - Partial: relay pending flush now checks each send result and retains the
     current plus remaining queued messages on send failure instead of dropping
     them before delivery is confirmed.
   - Partial: process-local relay direct dispatch now emits typed delivery
     debug metadata for thrown send/encrypt failures instead of only returning
     a deferred result to the caller.
   - Partial: relay router direct socket forwarding now returns a typed
     delivery result internally, so `send()` false is reported as `send-failed`
     instead of being conflated with stale target sockets.
   - Partial: process-local relay direct dispatch now emits typed delivery
     debug metadata for missing source/target runtime encryption keys instead
     of silently returning only a deferred result to the caller.
   - Exit: callers receive one typed delivery result and no longer reimplement
     retry/defer/fatal decisions per call site.

7. **Canonical identity refs.**
   - Treat jurisdiction/entity/account refs as protocol identity and display
     names as cosmetic only.
   - Delete alias allowlists and name-based matching from runtime, market maker,
     health, and tests.
   - Partial: shared jurisdiction identity helpers now derive canonical
     `stack:<chainId>:<depository>` refs and hub/MM bootstrap readiness compares
     those refs before falling back to legacy display names for incomplete
     fixtures.
   - Partial: orchestrator now passes chain/depository in market-maker support
     identities, and hub/MM matching refuses name-only fallback when either
     side already carries a canonical jurisdiction ref.
   - Partial: hub peer reserve bootstrap now groups visible peer hubs by
     canonical jurisdiction ref and resolves the funding J-adapter by that ref
     before using legacy names.
   - Partial: removed the permissive one-ref-vs-name jurisdiction matcher; the
     remaining fallback only matches display names when both sides lack refs.
   - Partial: removed the runtime hub-node display alias allowlist that rewrote
     Arrakis/Wakanda/shared-anvil labels to Testnet.
   - Partial: removed frontend wallet/swap display aliasing that rewrote
     arrakis/wakanda/local test labels to Testnet/Tron during default imports
     and account/orderbook label rendering.
   - Partial: market-maker jurisdiction import/adaptor detection now compares
     canonical jurisdiction refs only and no longer treats matching display
     names as imported jurisdiction identity.
   - Partial: hub support-peer identities, visible hub filtering, and peer
     reserve catalog selection now require canonical jurisdiction refs instead
     of falling back to matching display names.
   - Partial: deleted the remaining runtime jurisdiction name-fallback helper;
     tests now assert name-only jurisdiction objects are not identity matches.
   - Partial: `/api/jurisdictions` and hub runtime jurisdiction payloads now
     preserve configured/runtime display labels instead of forcing `arrakis` to
     `Testnet`.
   - Partial: mesh jurisdiction selection now resolves primary stacks by exact or
     public RPC URL and explicit `primary:true`, so hub/MM/server bootstrap no
     longer depends on an `arrakis` config key for renamed primary jurisdictions.
   - Partial: browser runtime create/restore now selects the first usable
     `primary:true` jurisdiction, or the first active jurisdiction with contracts,
     instead of depending on an `arrakis` key.
   - Partial: push-wake registration now resolves the J-replica by canonical
     `(chainId, depositoryAddress)` stack identity and fails closed instead of
     accepting a display-name jurisdiction match.
   - Partial: browser runtime restore no longer rewrites a missing legacy
     `testnet` signer jurisdiction to the current primary jurisdiction; missing
     signer jurisdiction now remains explicit.
   - Partial: stack-ref jurisdiction lookup now resolves only by canonical
     `(chainId, depositoryAddress)` identity and cross-j local binding no longer
     accepts display-name/depository-only fallbacks.
   - Partial: hub peer reserve bootstrap now requires visible hub profiles to
     carry canonical jurisdiction refs and resolves funding J-adapters only by
     that ref, not by jurisdiction display name.
   - Partial: market-maker visible hub discovery now drops name-only
     jurisdiction profiles before readiness/health planning instead of carrying
     unmatched display-name hubs through the bootstrap loop.
   - Partial: market-maker bootstrap role ordering and fingerprints now use
     canonical jurisdiction refs instead of mutable jurisdiction display names.
   - Exit: adding a new testnet label cannot break hub/MM matching.

8. **Canonical fill and amount representation.**
   - Exact bigint amounts are the source of truth.
   - `uint16` fill ratios are a one-way lossy projection for on-chain
     hash-ladder proofs only; never round-trip ratio data back into exact
     settlement amounts.
   - Partial: cross-j claim progress now preserves exact committed
     `filledSourceAmount`/`filledTargetAmount` and exact claim totals instead
     of rehydrating them from the uint16 hash-ladder ratio during pull close.
   - Partial: cross-j orderbook remaining amounts, cancel ACKs, and fill-notice
     idempotency now share exact committed fill amount resolution before using
     legacy uint16 ratio fallback.
   - Partial: cross-j close proofs and subsequent fill validation now also use
     shared exact committed fill resolution, so exact-only partial route state
     cannot drift when the next ACK or close proof is built.
   - Partial: cross-j pull bindings now materialize exact committed fill
     amounts and preserve exact ratio fields, so account-level close proof
     checks do not fall back to uint16-derived economics.
   - Partial: committed-fill detection now uses the shared exact-aware resolver
     instead of bespoke ratio/amount predicates.
   - Partial: exact fill numerator/denominator now project the coarse
     hash-ladder proof ratio inside the shared resolver when legacy
     `cumulativeFillRatio` is absent, and source clear uses that resolver
     instead of treating exact-only committed fills as empty.
   - Partial: account/entity pull close, pull resolve, and cross-j salvage
     proof-boundary checks now use the same exact-aware committed proof-ratio
     helper instead of local `cumulativeFillRatio/claimedRatio` math.
   - Partial: cross-j fill ACK cancel handling, duplicate fill-notice
     idempotency, and pending-fill metadata now derive their proof ratio from
     exact numerator/denominator when the legacy coarse field is absent.
   - Partial: duplicate cross-j book progress now uses the exact-aware proof
     ratio helper, so exact-only replay clears pending fill instead of failing
     stale.
   - Partial: cross-j fill validation, pull-resolve followups, and claim
     progress now all derive committed proof ratio through the shared
     exact-aware helper when legacy coarse ratio is absent.
   - Partial: committed exact-only terminal fill ACK followup now routes through
     clear handling instead of falling back into book-progress repair when
     legacy coarse ratio is absent.
   - Partial: account-level cross-j fill ACK validation now relies on the shared
     exact progress validator for both source and target cumulative amounts
     instead of a duplicate source-only exact-ratio check.
   - Partial: quantized-claim projection now fail-fast validates incomplete or
     out-of-range exact ratio fields instead of silently falling back to the
     lossy uint16 projection.
   - Partial: proof-ratio, committed-amount, quantized-claim, and fill-progress
     validation now share one exact ratio parser/error code instead of four
     manual numerator/denominator checks.
   - Partial: cross-j account ACK, entity fill notice, and clear handlers now
     use `CROSS_J_MAX_FILL_RATIO` for terminal/full-fill decisions and display
     instead of local `65_535` / `MAX_SWAP_FILL_RATIO` constants.
   - Partial: remaining cross-j and pull event strings plus swap-offer
     `minFillRatio` validation now use the shared fill-ratio constants instead
     of embedding `65535`.
   - Partial: account frame proposal now statically imports dispute proof
     building and hanko batch signing instead of using `await import()` in the
     hot proposal path.
   - Partial: entity consensus now statically imports quorum hanko building,
     signer hash batching, and account-frame proposal dependencies instead of
     resolving them with `await import()` during frame commit/proposal.
   - Partial: j-batch event handling, R2C, and hub rebalance crontab paths now
     statically import shared batch helpers instead of resolving them during
     event/crontab execution.
   - Partial: account settlement action handling and DisputeStarted proof-body
     inspection now use static imports instead of resolving helper modules in
     account/J-event execution.
   - Exit: cross-j orderbook, claim, settlement, and dispute paths share one
     precision boundary and one set of dust/rounding invariants.

9. **Bootstrap lifecycle as an explicit state machine.**
   - Model startup phases and barriers the same way protocol state is modeled:
     P2P, relay, hubs, custody, MM same-chain offers, MM cross offers,
     watchtower, health.
   - A send/seed/quote action should be impossible before its barrier is met.
   - Exit: production health can show the exact blocked phase and dependency.

10. **Cold system fixture for fast tests.**
    - Build a verified cold fixture/template for the whole system: anvil
      chains, hub mesh, custody, MM same-chain books, MM cross books, watchtower,
      and runtime import manifest.
    - Tests should clone or hydrate from this fixture instead of rebuilding the
      full mesh for every short local loop.
    - Exit: local browser/radapter tests can start from a known full-ready
      state without weakening production readiness semantics.

11. **Orchestrator blast-radius boundaries.**
    - Decouple child process supervision from whole-tree failure.
    - Ancillary feature failure degrades that feature and keeps diagnostics
      queryable; protocol contradiction remains a loud fatal stop.
    - Exit: faucet/demo/MM/watchtower failure cannot take down the health
      endpoint needed to debug the node.

12. **Settlement conservation proof.**
    - Prove fund conservation across `pull_lock -> resolve -> on-chain release`
      on both legs, including debt/collateral and dispute finalization.
    - Cover `_disputeFinalizeInternal` line-by-line with adversarial fixtures.
    - Exit: external audit gets executable invariants, not just E2E success.

13. **Economics and scale validation.**
    - Document fee design, collateral ratios, market-maker incentives, and
      griefing costs for swaps and disputes.
    - Profile runtime/orderbook/MM under contention before raising real-money
      limits.
    - Exit: mainnet limits are backed by measured capacity and explicit
      incentive assumptions.

14. **Full TypeScript 7 tooling migration.**
    - Staged now: runtime typecheck uses the pinned TS7 native compiler through
      `@typescript/native`, while `typescript@5.9` remains installed for tools
      that import the compiler API.
    - Defer full switch until Svelte, ESLint, Hardhat, TypeChain, and ts-node
      paths are proven compatible with TS7's API/tooling story.
    - Exit: all repo typecheck, lint, contract, frontend, and editor tooling use
      one TS7 toolchain without compatibility aliases.

## P2 - Product And UI

1. **Lending tab.**
   - Product/runtime design lives in `docs/lend.md`.
   - Do not mix this with the current production swap/health gate.
   - Exit: hub lending pools, fixed-term lend/borrow/repay lifecycle, and
     browser E2E are green on Testnet and Tron.

2. **Token support boundary.**
   - Either prove multi-token collateral E2E or keep the product explicitly
     USDC/single-token for the current release line.

3. **Custody and fee UX.**
   - Make custody balance and auto-fee behavior read as one coherent flow.

4. **SettlementPanel consistency.**
   - Keep direct on-chain flows and entity/quorum flows visually and logically
     distinct.

5. **Activity/account-card context.**
   - Show routing, HTLC, swap, J-event, dispute, and recovery events clearly
     enough for demo and support/debug use.

6. **Remote runtime time machine.**
   - Browser UI requests historical subset snapshots through RAdapter; no local
     browser-only replay of remote state.
   - Paginate large entity/account/book lists by default with configurable
     page size.
   - Exit: operator can inspect a selected remote hub at a past height without
     freezing the wallet.

7. **UX screenshot release evidence.**
   - Keep at least 30 curated screenshots across desktop/mobile covering
     onboarding, assets, accounts, payment, swap, cross-chain swap, disputes,
     on-chain batch/history, health, QA, RAdapter import, and time machine.
   - Exit: QA cockpit gallery opens every curated screenshot and slideshow
     navigation works from keyboard/clicks.

8. **Pre-mainnet admin stories.**
   - Keep four first-screen videos in QA cockpit: payment, swap, cross-chain
     swap, dispute.
   - Each story needs a short operator description and synchronized playback
     transcript.

9. **AI court app after core health/QA work.**
   - Finish the existing AI court app with XLN token intake, challenge flow,
     adjudication, and winner-takes-all settlement.
   - Not a mainnet readiness blocker until protocol/admin gates are green.

## Auxiliary AI Work

These are useful local-product tasks but not XLN launch blockers.

- Finish GPT-OSS 120B MLX download at `~/models/gpt-oss-120b-heretic-mlx`.
- Install `piper` so `/api/synthesize` can produce voice locally.
- Fix the green visual speech indicator in `/ai`.
