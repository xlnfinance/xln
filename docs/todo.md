# todo

Last updated: 2026-06-24

Scope: synthesized from four external admin/QA/runtime audits. This is the operator-grade backlog for `/health`, `/qa`, runtime adapter import, test history, scenario playback, restart controls, and regulator evidence.

## architecture decisions 2026-06-24

- Remote runtime multi-import opens a dedicated settings/manager screen, pre-fills a textarea, and waits for a human `Confirm` click before validating/importing.
- Remote runtime import secrets travel in the URL `#fragment`, not query params, so tokens do not hit server/proxy logs. Lines may be raw URLs that already contain token/connect/scope data; labels are optional and can be edited later.
- `/health` is current live system state. `/qa` is integration/test/process history and the long-lived evidence cockpit. Read mode can see full data, but privileged actions stay visible and disabled.
- QA/scenario evidence should live in one DB/UI surface across unit, contract, e2e, benchmark, scenario, and release gates. Screenshots are release evidence, not throwaway artifacts.
- Scenario commentary is authored text over real video-clock timestamps. Video speed and commentary must stay synchronized, with no duplicate transcript surfaces.
- Benchmark regression threshold is 20%; unexpected important regressions should ask the operator for a decision. Restart workflow may include abort/kill controls.
- Time Machine is remote-server-backed through R-adapter snapshots/subsets, not local browser replay. Large runtime state uses aggregate/cursor/hash slices, defaulting to 10-20 items per page.
- Remote runtime creation is not mandatory yet; console/server-side creation is acceptable until a wallet-side manager is designed.

## audit scores

- ideas1: 910/1000. Strong target spec and good product framing. Less grounded in current code, but correctly emphasizes run ledger, severity, audit trail, read/admin split, and 1M snapshot discipline.
- ideas2: 945/1000. Grounded in current code and strongest on auth, CORS, restart audit trail, verdict banner, regression detection, and API contract gaps.
- ideas3: 970/1000. Best audit. Finds the highest-risk concrete issues: fake video transcript sync, unauthenticated QA API, full env passed into restart child, history re-ingest on every poll, perf sample payload bloat, timezone mismatch.
- runtime-audit4: 965/1000. Strong code-path audit across reserve faucet, remote runtime token logging, watcher cursor clamp, external-wallet baseline, approveErc20 type drift, remote orderbook depth, and strict `0x` snapshot handling.
- intern1: 940/1000. Strong dead-weight and reorg audit. Highest-value findings are the BrowserVM half-dead fallback, duplicated reserve faucet handler, `recentJEvents` evidence race, externalWallet living in consensus hot-path plumbing, and `EntityPanelTabs.svelte` god-file risk.
- combined target spec: 955/1000. Direction is correct: central-bank admin cockpit needs trust evidence, not just a prettier test page.

## p0 ship blockers

- [x] Make QA cockpit operator-open by default.
  - Impact: high.
  - Product decision: auth is deferred to the next feature; central admin UX should not require tokens during local/operator runs.
  - Status: done. If `XLN_QA_READ_TOKEN`/`XLN_QA_ADMIN_TOKEN` are unset, `/api/qa/*` works as open admin scope. If tokens are configured, read/admin checks still work.
  - Evidence: unit covers open-default catalog access, configured-token 401/403 behavior, and explicit disabled escape hatch. UI collapses the bearer-token strip in open mode.

- [x] Remove `Access-Control-Allow-Origin: *` from QA artifact and story-image responses.
  - Impact: critical.
  - Status: done. Media responses now use no CORS wildcard and include `X-Content-Type-Options: nosniff`.
  - Evidence: unit asserts story-image media has no `Access-Control-Allow-Origin`; QA video/screenshots load through bearer `fetch` and blob URLs.
  - Follow-up: signed, short-lived artifact URLs are still useful for external regulator export bundles.

- [x] Add append-only restart audit trail.
  - Impact: critical.
  - Status: done. Restart creates a SQLite `qa_restart_audit` row with hashed actor key id, scope, operator, reason, expected/actual HEAD, code hash, dirty flag, pid, exit code, log path, IP, and user agent.
  - UI: admin restart requires typed confirm `RUN`, visible target, expected HEAD, current code hash, dirty flag, and required reason. History tab shows the restart ledger.
  - Evidence: unit covers missing reason/confirm/expected HEAD and audit start/finish update; focused browser e2e covers the History restart trail and disabled run button.

- [x] Stop passing full `process.env` into restart child processes.
  - Impact: critical.
  - Status: done. Restart children receive an explicit Playwright/runtime allowlist, not `process.env`.
  - Evidence: `buildQaRestartEnv()` unit keeps required Playwright vars and strips QA tokens, secret sentinels, and private keys.

- [x] Redact runtime import token URL from orchestrator logs.
  - Impact: critical.
  - Status: done. Runtime import stdout logs redact token-bearing URLs by default; `bun run dev` is the explicit local exception via `XLN_RUNTIME_IMPORT_LOG_URL=1` so the operator gets one clickable bootstrap link. Hub inspect URLs are still logged without query/hash secrets.
  - Evidence: unit asserts default log lines contain no `runtime-import=`, `xlnra1.`, token strings, or base64 manifest; a separate unit asserts the full URL is exposed only when explicitly requested. Focused browser e2e imported mesh/custody/MM runtimes from the manifest.

- [x] Replace per-runtime paste links with one prefilled remote-import manager link.
  - Impact: critical.
  - Status: done. `bun run dev` suppresses early keygen/Vite URLs and lets the orchestrator print one final `/radapter/manage#runtime-import=...` link after H1/H2/H3/MM/Custody are bootstrapped with real runtimeId-bound tokens. Tokens live in the URL fragment, the manager pre-fills the bulk textarea, immediately scrubs the fragment from the address bar, and imports only after the operator presses Confirm.
  - Evidence: focused unit PASS `6/6` asserts standalone keygen prints one manager fragment link and dev-mode can suppress it. Focused browser e2e PASS `2/2`, run `20260624-135733-077`, expects no `?runtimeList`, no query token, visible prefilled textarea, empty import summary before Confirm, then verifies mesh/custody/MM runtimes are imported and live after Confirm.

- [x] Move manual Remote Manager out of the main app dropdowns.
  - Impact: high.
  - Status: done. Context/runtime dropdowns no longer render the attach/bulk form or a remote-manager link. Manual attach/bulk import now lives only on the dedicated `/radapter/manage` page.
  - Evidence: focused radapter e2e PASS `2/2`, run `20260624-135733-077`, asserts the context dropdown has no `remote-runtime-manager` and no `.remote-manager-link`, opens `/radapter/manage`, attaches H2 by token, redirects to `/app`, and verifies the remote runtime is active. The bulk import e2e validates the single fragment manager URL for H1/H2/H3/MM/Custody.

- [x] Fix reserve faucet missing-event invariant.
  - Impact: high.
  - Current issue: faucet could return `500 RESERVE_EVENT_MISSING` after `getReserves()` confirmed the money moved.
  - Product decision: this should not be downgraded to best-effort. The event should arrive in runtime before application; if reserve grew without a recent event, that is an invariant bug.
  - Root cause: watcher-fed canonical J-events were enqueued/applied through `processEventBatch` without being recorded in recent evidence, and the global 1,000-event ring could be displaced by unrelated jurisdiction traffic.
  - Status: done. Submitted J-events and watcher-ingress J-events now share one evidence recorder; `ReserveUpdated` is also indexed by `entityId:tokenId`, so unrelated traffic cannot hide the matching reserve event.
  - Evidence: L1 failed before fix, then passed: two-jurisdiction watcher reserve evidence survives 1,100 unrelated reserve events and still rejects `expectedMin` above the matching event.

## p1 trust and correctness

- [x] Replace fake video transcript sync with real in-browser cue timestamps.
  - Impact: high.
  - Current issue: scenario cues are synthesized from phase durations and linearly mapped to video duration. Setup phases that are not in the Playwright video can appear as subtitles over wallet footage.
  - Fix: record cue timestamps from browser/test markers relative to video start. Store `cues.json` and generate WebVTT. Keep infra setup phases in a separate setup strip, not in video subtitles.
  - Tests: browser E2E asserts a cue text matches the actual video step window; WebVTT loads; cue click seeks to expected video time.
  - Status: done. `timedStep()` now emits `[E2E-CUE]` markers with video-relative `startMs/endMs`; the runner writes `qa-cues/cues.json` and `qa-cues/cues.vtt`, and the manifest parser keeps legacy duration-only logs as fallback. QA Scenario Player uses video-clock cues directly and excludes setup phases from subtitles when real cues exist.
  - Evidence: unit covers cue parsing/replacement; focused QA cockpit browser test verifies real offset text, protected WebVTT track loading, no setup phase subtitles, cue click seek, video artifact loading, and zero browser issues.

- [x] Capture browser console errors, page errors, failed requests, and HTTP 4xx/5xx per shard.
  - Impact: high.
  - Status: done. Playwright specs import the shared QA fixture, which records unexpected console warnings/errors, `pageerror`, failed non-benign requests, and HTTP 4xx/5xx into shard JSONL. The isolated runner folds this into manifest `browserIssues` and `browserHealth`, history SQLite counters, run rows, verdict, failure inbox, and shard Browser Health panel.
  - Policy: benign local analytics warnings and navigation/static `net::ERR_ABORTED` cancellations are filtered; page errors, HTTP 5xx, and real failed fetch/xhr/network issues remain blocking.
  - Evidence: unit covers browser issue normalization/history counts; focused QA cockpit e2e fixture shows FAIL from browser health and a clean real focused run records browserHealth 0/0/0/0.

- [x] Add unified severity model.
  - Impact: high.
  - Statuses: `OK`, `WARN`, `DEGRADED`, `FAIL`, `BLOCKED`, `UNKNOWN`.
  - Required fields: `severity`, `reason`, `since`, `owner`, `evidence`.
  - Apply to health, QA runs, bootstrap stages, restart state, remote adapter, and benchmarks.
  - Tests: API schema rejects missing `severity`/`reason` for release runs.
  - Status: done. Shared runtime severity contract exists. QA run/shard/browser-health/benchmark manifests are normalized on legacy reads; new runner manifests are `manifestVersion: 3` and gated by `assertQaReleaseRunSeverity`. Restart state and restart audit rows expose severity fields. `/health` computes one health severity, testnet gates carry severity, bootstrap stages carry severity, and the runtime adapter panel reports remote-adapter severity.
  - Evidence: `bun test runtime/__tests__/qa-story-report.test.ts` covers legacy normalization, v3 schema rejection for missing `severity`/`reason`, benchmark degradation severity, and restart audit severity. `cd frontend && bun run check` verifies health/bootstrap/remote-adapter Svelte surfaces.

- [x] Add failure class per shard/run.
  - Impact: high.
  - Classes: `assertion`, `infra`, `timeout`, `flake`, `crash`, `security`, `unknown`.
  - Fix: derive from phase failure, fatal markers, Playwright result, console/page errors, and history at same code hash.
  - UI: filter by failure class; default-select first blocking failure.
  - Tests: infra boot failure is not rendered as assertion regression.
  - Status: done. Runner writes `failureClass` per shard and `failureClasses` per run; legacy manifests derive the field on read. QA cockpit shows class chips on run rows and shard detail, failure inbox clicks set the active class filter, and manual class chips filter both run list and inbox. Loading or opening a failure selects the first failed shard matching the active class before falling back to the first failed shard.
  - Evidence: unit covers timeout/assertion/infra/passed classifier behavior. Focused QA cockpit e2e verifies `assertion` filtering, run row chips, inbox narrowing, and shard detail class chips.

- [x] Fix radapter admin-state e2e height stalling after control mutation.
  - Impact: high.
  - Status: done. The admin-control test now uses explicit awaited Playwright-side polling and returns the proven post-write probe as the assertion source; it no longer relies on an async `waitForFunction` predicate that could let the final read race the Svelte view update.
  - Root cause: broad split runs exposed a readiness race in the test harness. The adapter head/frame could be updated while `window.isolatedEnv` was still one Svelte view refresh behind, producing `beforeHeight=18` and `after.height=18` in the final assertion.
  - Evidence: focused admin-control e2e passes. Broad `tests/e2e-radapter-remote.spec.ts` now passes `5/5`, including the previously failing shard 2 admin-control test.

- [ ] Fix numeric signer key cache isolation by runtime seed.
  - Impact: high.
  - Current issue: numeric signer private keys are cached by `signerId` only. Two test/runtime envs in one Bun process with different `runtimeSeed` and signer `2` can reuse the wrong private key and trigger `LAZY_HANKO_SELF_MISMATCH`.
  - Constraint: consensus/crypto path; require explicit design approval before changing. Candidate fix is cache numeric derivations by `(seed fingerprint, signerId)` while keeping registered EOA keys keyed by address.
  - Tests: two envs with different seeds and same numeric signer process frames in one Bun process without cache cross-contamination.

- [x] Scope watcher start-block clamp to the watcher's own jurisdiction/depository.
  - Impact: high.
  - Current issue: minimum finalized J height is taken across all entity replicas, so an unrelated entity/jurisdiction can drag a watcher backward and cause re-scan storms.
  - Fix: compute min height only for entities whose depository/jurisdiction matches the watcher.
  - Tests: two-jurisdiction env with low unrelated entity does not lower watcher cursor.
  - Status: done. `getWatcherStartBlock()` now computes the signer finalized-height cap through the matched watcher `JReplica`. Entity replicas are relevant by matching `config.jurisdiction.depositoryAddress` first, then jurisdiction name/chain; legacy unbound replicas still preserve the old single-jurisdiction behavior.
  - Evidence: new L1 regression failed before fix with Arrakis start block `6` instead of `101`, then passed. `bun test runtime/__tests__/jadapter-helpers.test.ts` PASS `15/15`; L2 watcher runtime suite PASS `18/18`; runtime `tsc` PASS.

- [x] Add opt-in watchtower push-wake for dispute victims.
  - Impact: high.
  - Goal: if a `DisputeStarted` event targets an offline entity, the standalone watchtower can wake the victim's registered device so the user can sync and respond before the dispute window closes.
  - Status: done. The watchtower has signed `/api/push/register` and `/api/push/unregister` handlers, a LevelDB push registry, cursor/dedup storage, opt-in `--enable-push-wake` sweep scheduler, console/webhook senders, and health stats. Wakes are matched to the counterentity/victim, never the starter, and unregister is scoped to `(runtimeId, tokenHash)`.
  - Evidence: L1 `bun test runtime/__tests__/push-dispute-wake.test.ts` PASS `8/8`; runtime `tsc` PASS. The test covers victim-only targeting, wrong-chain/depository filtering, signed registration tamper rejection, runtime-scoped unregister, signed token-hash unregister without retaining raw client token, HTTP register/unregister handlers, sweep dedup, and tappable notification payload.

- [x] Wire wallet/native push-token registration to the watchtower push-wake API.
  - Impact: medium-high.
  - Requirement: no mock tokens in production UX. The wallet signs the registration message with the runtime owner key, sends the real APNs/FCM/Web Push token, shows registration status, and lets users revoke it.
  - Status: done. Recovery settings now include a Push Wake panel that obtains a real desktop bridge, Capacitor native, or Web Push token, signs register/unregister requests with the runtime owner key, stores only token hashes locally, and calls the same-origin watchtower proxy for local HTTPS wallet sessions. The browser path supports a shell-provided server-reachable RPC override so standalone watchtowers never need to call the wallet's self-signed Vite RPC proxy.
  - Evidence: L1 `bun test runtime/__tests__/push-dispute-wake.test.ts runtime/__tests__/watchtower-proxy.test.ts tests/frontend/push-wake-registration.test.ts tests/frontend/recovery-tower-config.test.ts` PASS `25/25`. L2 isolated browser e2e `tests/e2e-push-wake-registration.spec.ts` PASS `1/1`, run `20260624-022222-222`, wall `21.0s`, HEAD `4f93bde67b08`, code hash `09d7f5cde7fdc309df26aba46c63c6b7139d865fc22b98ca8e73ce48f1f12902`, browser issues `0`, watchtower sweep `notificationsSent=1`.

- [x] Consolidate the duplicated reserve faucet implementation.
  - Impact: high.
  - Current issue: `runtime/server/reserve-faucet.ts` is the canonical handler, but `runtime/orchestrator/hub-node.ts` still had a stale inline `/api/faucet/reserve` copy with old wait helpers.
  - Status: done. hub-node now calls `handleReserveFaucet()` with its local bootstrap hub and token catalog deps; the inline route body and local wait/reserve helpers were deleted.
  - Evidence: runtime typecheck and `bun run check` cover the shared handler wiring.

- [x] Keep BrowserVM for visual debugger and make its adapter boundary explicit.
  - Impact: high.
  - Current issue: `mode: 'browservm'` is still required by the visual debugger / Graph3D simnet path, but the audit wording treated it as removable because `createBrowserVMAdapter()` is throw-only.
  - Decision: do not delete BrowserVM. Clarify the intentional debug/simnet boundary, remove only unreachable throw-only fallback paths, and keep Graph3D/JurisdictionPanel BrowserVM flows working.
  - Tests: BrowserVM smoke test deploys and watches events; visual debugger/Graph3D e2e opens a BrowserVM-backed runtime without startup fallback reaching a throw-only adapter.
  - Status: done. BrowserVM now has a real `JAdapter` wrapper over `BrowserVMProvider`, emits transaction-bound events through the shared watcher path, supports typed contract reads/writes, snapshots/revert, and keeps the boundary documented as debug/simnet rather than release evidence.
  - Evidence: `bun x tsc -p tsconfig.runtime.json --noEmit` PASS; `bun test runtime/__tests__/browservm-adapter.test.ts` PASS `1/1`; browser-target `bun build runtime/runtime.ts --target=browser ...` PASS; focused isolated e2e `tests/e2e-jurisdiction-settings.spec.ts` PASS `2/2`, wall `22.5s`, browser errors `0`, run `20260624-001843-259`, code hash `85c16db3bd818999`.

- [x] Fix external-wallet snapshot baseline to use confirmed block, not tip.
  - Impact: medium.
  - Current issue: snapshot block can be reorged out on non-anvil RPC. This is display state, not consensus state, but still wrong evidence.
  - Fix: snapshot at `currentBlock - confirmationDepth`, include `sourceHeight`, `sourceHash`, and `finalityDepth`.
  - Tests: snapshot uses safe block; UI shows source height/hash.
  - Status: done. External-wallet API and local UI snapshots now resolve a safe source block from `getCurrentBlockNumber() - getFinalityDepth()`, read balances at that block tag, emit/apply the canonical `ExternalWalletSnapshot` at the source height/hash, and return source metadata to the browser. Assets shows a compact snapshot source line under the external EOA.
  - Evidence: L1 `bun test runtime/__tests__/external-wallet-api.test.ts` PASS `4/4` and proves tip `77` with depth `1` reads block `76`; wiring unit PASS `25/25`; focused screenshot e2e PASS `3/3`, wall `53.8s`, code hash `879f68670bb0a991`, browser errors `0`, benchmark OK vs `20260624-005624-512`, and asserts `external-wallet-source` renders.

- [ ] Move display-only `externalWallet` state out of consensus hot-path entity state.
  - Impact: medium-high.
  - Current issue: external wallet state is cloned/validated/persisted with EntityState even though it is excluded from the frame hash.
  - Fix: move it to `env.runtimeState` or a dedicated side store keyed by entityId, with explicit source height/hash/finality metadata.
  - Tests: entity frame hash remains unchanged by wallet display deltas; wallet panel still renders from side-store snapshots.

- [x] Fix runId/timezone model.
  - Impact: medium.
  - Current issue: runId is local-time based while legacy parsing assumes UTC. UI uses locale string without timezone.
  - Fix: generate run IDs in UTC or stop deriving timestamps from run IDs when manifest has epoch. Render `YYYY-MM-DD HH:mm:ss UTC`, with local time only as hover/secondary.
  - Tests: runId timestamp round trip is deterministic across timezones.
  - Status: done. QA e2e run IDs now use UTC fields through `formatQaRunIdUtc()`, legacy parsing remains UTC, and QA cockpit renders timestamps as fixed `YYYY-MM-DD HH:mm:ss UTC` instead of browser locale strings.
  - Evidence: unit covers UTC runId formatting around midnight; focused QA cockpit e2e fixture asserts visible UTC timestamp text in the verdict banner.

## p1 product and UX

- [x] Add single system verdict banner.
  - Impact: high.
  - UI: sticky top banner with `SYSTEM PASS/DEGRADED/FAIL`, failing surface count, last run UTC, git HEAD, code hash, dirty flag, regression status, browser error count.
  - Drill-down: clicking a reason filters runs/shards to exact evidence.
  - Status: done. `/api/qa/runs` now returns a schema-backed `QaSystemVerdict` built from the latest run summary, including active/failing surface counts, UTC run time, git HEAD, code hash, dirty flag, benchmark status, and browser error/warning counts. `/qa` renders that backend verdict and only overlays local operations failures.
  - Evidence: L1 `bun test runtime/__tests__/qa-story-report.test.ts` PASS `34/34`; focused QA cockpit e2e `20260624-023242-580` PASS `1/1`, wall `11.3s`, code hash `c9ffc08fe7c195ab`, benchmark OK. Fixture proves backend-driven FAIL and green PASS verdicts.

- [x] Build canonical run ledger.
  - Impact: high.
  - UI/API fields: status, severity, suite, category, gitHead, codeHash, dirty, startedBy, duration, failedShard, artifactBytes, cpuP95, ramPeak, browserErrors, networkFailures, audit action.
  - API: `/api/qa/runs` reads SQLite history as canonical source; manifest JSON is ingest/backfill only.
  - Status: done. `/api/qa/runs` now returns `ledger` rows with canonical operator fields: severity/status, suite key/label, category, git HEAD/branch, code hash, dirty flag, startedBy, duration/timings, failed shard/targets, artifact bytes, CPU p95, CPU peak, RAM peak, browser/network counts, benchmark delta, compared run, and audit action. SQLite persists `child_cpu_p95_pct` separately so sample stripping does not erase ledger evidence.
  - UI: History includes a `Canonical Ledger` table sorted by the shared run speed/date selector, so benchmark deltas and failed surfaces are visible without opening a shard.
  - Evidence: L1 `bun test runtime/__tests__/qa-story-report.test.ts` PASS `35/35`; focused QA cockpit e2e `20260624-024105-955` PASS `1/1`, wall `10.8s`, code hash `be6241adbd805baa`, benchmark OK. Fixture verifies rendered ledger fields and sort order.

- [x] Add operator sorting by run/test speed and launch time.
  - Impact: high.
  - Status: done. `/api/qa/runs` and `/api/qa/history` expose timing summaries: stack wall, avg/max shard, bootstrap, health wait, and Playwright/browser phase.
  - UI: sidebar/history can sort by newest/oldest, fastest/slowest stack, bootstrap, browser, and test. Selected run shards can sort by recorded order, duration, bootstrap, and browser phase.
  - Evidence: focused QA cockpit e2e verifies stack-fast/date sorting in run list and history; unit covers timing report ingestion.

- [x] Add initial failure inbox UX shell.
  - Impact: high.
  - Status: done. `/qa` now shows a latest-first failure inbox for failed runs, benchmark regressions, dirty/latest degraded state, and failed restart audit rows.
  - UI: each reason shows severity, class, detail, timestamp, and opens the related run/history surface.
  - Evidence: focused QA cockpit e2e verifies `DEGRADED` verdict from benchmark regression, performance inbox item, click-through to the related run, and no browser console errors.

- [x] Add regression comparator.
  - Impact: high.
  - Compare current run vs previous same code hash, previous same HEAD, and last green on main.
  - Metrics: wall time, phase time, peak load, child CPU, runner RSS, artifact bytes, new failing handles.
  - UI: `REGRESSION` badge with percent deltas and threshold reason.
  - Status: done. `/api/qa/runs` now returns a `regression` report for the latest suite, comparing against previous comparable, previous same code hash, previous same HEAD, and last green on main. The report covers wall/phase timings, host load, child CPU p95/peak, runner RSS, child RSS, artifact bytes, and new failing targets; `peakLoad1` remains non-blocking when app timings are healthy.
  - UI: Benchmarks tab shows a Regression Comparator with `FAIL/SLOWER/MIXED/OK/NEW`, baseline run IDs, top percent deltas, new failing handles, and likely causes.
  - Evidence: L1 `bun test runtime/__tests__/qa-story-report.test.ts` PASS `36/36`; focused QA cockpit e2e `20260624-123022-236` PASS `1/1`, wall `12.0s`, code hash `9adf798a4948d81f`, benchmark OK. Fixture verifies previous/same-code/same-HEAD/last-green comparison and rendered regression badge/delta.

- [x] Add phase-time waterfall per shard.
  - Impact: medium.
  - UI: stacked bar for preflight, anvil, API boot, health, Vite, Playwright. Flag phase above p95 historical.
  - Tests: phase fixture renders stable labels and flags budget breach.
  - Status: done. `/api/qa/run` now includes `phaseWaterfall` per shard, `/api/qa/runs` and history rows persist `timing.phaseP95`, and the QA cockpit selected-shard panel renders a stacked phase waterfall with per-phase ms, share %, p95/budget label, and `over budget` breach state.
  - Evidence: L1 `bun test runtime/__tests__/qa-story-report.test.ts` PASS `37/37`; focused QA cockpit e2e `20260624-130238-476` PASS `1/1`, wall `12.1s`, code hash `cd7c8bca7c21b171`, benchmark OK. Fixture verifies stable phase labels plus `playwright` budget breach rendering.

- [x] Add failure inbox.
  - Impact: high.
  - Inputs: fatal runtime markers, browser/page errors, network failures, phase budget breaches, restart failures.
  - UI: one page/list of latest failure causes linking directly to shard, log tail, video time, artifact.
  - Partial shipped: inbox covers failed runs, browser/page/network/HTTP health, benchmark regressions, phase budget breaches, failed restart audit rows, selected-shard deep links, and failure-cue video focus.
  - Evidence: focused QA cockpit e2e `20260624-130628-512` PASS `1/1`, wall `12.3s`, code hash `36dbc2aaf5893ecd`, benchmark OK. Fixture verifies `Phase budget exceeded` inbox item and shard focus.
  - Status: done. Backend summaries now extract redacted fatal marker lines per shard, and the cockpit renders them as `FAIL crash` inbox items that deep-link to the exact shard/log panel alongside browser, benchmark, phase, and restart failures.
  - Evidence: L1 `bun test runtime/__tests__/qa-story-report.test.ts` PASS `38/38`; focused QA cockpit e2e `20260624-131200-583` PASS `1/1`, wall `12.4s`, code hash `e5e36c3736265c36`, benchmark FASTER. Fixture verifies fatal marker inbox copy, exact shard focus, and phase breach inbox item.

- [x] Add e2e UX screenshot gallery for design audits.
  - Impact: high.
  - Status: done. Curated e2e screenshots now write PNG plus JSON metadata both into Playwright artifacts and the static repo gallery at `tests/e2e/screenshots/ux-gallery/{desktop,mobile}`; `/api/qa/stories` reads metadata and QA cockpit opens on `UX Gallery` by default.
  - Coverage: focused screenshot + move e2e generated 33 curated PNGs and 33 metadata sidecars across onboarding, assets, accounts, payment, receive, cross-chain swap menus, on-chain batch compose/queue/history, dispute controls, history, and settings.
  - Evidence: unit enforces at least 20 curated screens and required groups `Payments`, `Swap`, `On-chain Batch`, `Disputes`, `History`; focused QA cockpit e2e verifies default gallery rendering, counts, and categories.
  - Revalidated: run `20260623-200141-886` regenerated 30 gallery artifacts on HEAD `20aa9c0d`; QA cockpit run `20260623-200321-059` passed gallery visibility.

- [x] Make the UX screenshot gallery a mandatory 30-screen release audit pack.
  - Impact: high.
  - User-confirmed: keep at least 30 different screenshots from different parts of the app as a stable visual audit source; reconfirmed 2026-06-24.
  - User-reconfirmed 2026-06-24: keep this as a hard release requirement even though the first implementation already ships 37 static PNGs.
  - Requirement: every release-quality e2e run refreshes at least 30 named PNG screens across desktop and mobile covering onboarding, home/assets, payments, receive, swap, cross-chain swap, disputes, on-chain batch compose/queue/history, account history, settings, QA cockpit, health, remote runtime import, and Time Machine.
  - UI: QA cockpit shows the 30-screen pack as a first-class gallery with category filters, viewport badges, scenario names, git HEAD/code hash, and missing-screen warnings.
  - Tests: unit fails if fewer than 30 curated screens or required categories are missing; focused QA e2e verifies the gallery renders 30 distinct screens and every image resolves.
  - Status: done. `/api/qa/stories` now returns a release-pack audit computed from the full static story catalog; QA cockpit shows READY/MISSING, counts, missing reasons, and group filters. `/embed` initializes settings so Time Machine screenshots can be captured deterministically.
  - Evidence: static gallery has 37 PNGs; L1 `bun test runtime/__tests__/qa-story-report.test.ts` PASS `32/32`; focused screenshot e2e `20260624-002946-321` PASS `1/1`, wall `10.0s`, code hash `63d9425a3d266fea`; focused QA cockpit e2e `20260624-003232-055` PASS `1/1`, wall `11.0s`, code hash `addca66df356e7c8`.

- [x] Make `/health` read only its dedicated health surface.
  - Impact: medium.
  - Goal: avoid mixing all admin dashboards into health. Health should embed or link QA cockpit, not become the full QA implementation.
  - UI: `/health` shows verdict, bootstrap/infra health, a link-only QA evidence panel, and runtime adapter inspector.
  - Status: done. `/health` no longer imports QA fetch helpers, QA run/story panels, protected QA images, or a QA iframe; it reads `/api/health`, `/api/debug/events`, `/api/debug/entities`, and `/rpc` only.
  - Evidence: unit scans the health route against forbidden QA surfaces; focused radapter e2e blocks `/api/qa/**` while loading `/health` and asserts no QA iframe or run panel exists.

- [x] Make Time Machine production-debuggable for the active remote runtime.
  - Impact: high.
  - User-confirmed: this must be a real working Time Machine when enabled in settings, not just a visual toggle.
  - User-reconfirmed 2026-06-24: enabling Time Machine in settings must switch the app into a real historical-debug mode, including remote hub past-state scans for debugging.
  - Status: done for active remote runtime debugging. The user-mode wallet now renders the same Time Machine bar as Dock mode when enabled. The bar exposes a remote height input, bounded Scan action, endpoint/status/latency/cache evidence, and switches the wallet into the selected historical frame without replacing the live runtime state.
  - Remote hub debug: uses existing R-adapter `view-frame` historical reads with `atHeight`, `accountsLimit=10`, and `booksLimit=10`; scanned snapshots merge into a capped 24-frame history cache, preserving the scanned height plus recent frames.
  - Evidence: L1 `bun run check:frontend` PASS with `svelte-check 0 errors / 0 warnings`; focused e2e `20260624-145903-953` PASS `1/1`, wall `9.5s`, code hash `8a227ff06a8db015`. The browser test mutates H1 through admin R-adapter, proves old/new `view-frame` profile state, enables Time Machine in user-mode, scans the old height through the UI, leaves LIVE mode, and verifies bounded history includes the requested frame. Benchmark FASTER vs previous failed run: browser test `35005ms -> 3638ms` (`-89.61%`).
- [x] Extend Time Machine with multi-target picker, current-vs-selected diff, and deep-linkable historical height.
  - Status: done. The remote Time Machine strip now exposes a runtime picker when multiple remote runtimes are imported, a bounded entity target picker for the active remote runtime, a compact live-vs-selected diff chip (`height/entities/accounts/books/target accounts/target books`), and a `Link` action that writes `#accounts?tmHeight=...&tmEntity=...&tmRuntime=...`.
  - Deep link: loading the link reapplies the remote entity target, scans the historical height through R-adapter, and leaves the wallet in historical mode. Runtime mismatch activates an imported runtime instead of silently scanning the wrong target.
  - Evidence: L1 `bun run check:frontend` PASS with `svelte-check 0 errors / 0 warnings`; focused isolated e2e `20260624-151259-664` PASS `6/6`, wall `25.7s`, code hash `3297e1698d9513b5`. The e2e mutates H1 through admin R-adapter, scans the old frame, verifies target picker, diff chip, URL fragment, reloads the deep link, and confirms the old frame is restored.

- [x] Separate privileged operations from read-only QA views.
  - Impact: high.
  - UI: read scope sees the full QA evidence surface, including redacted text artifacts, while privileged controls remain visible but disabled. Admin/open scope can plan/backfill/purge, and restart run still requires reason, `RUN`, expected HEAD, and server-side `XLN_QA_RESTART_ALLOWED=1`.
  - Status: done. Secret-bearing text artifacts are readable with read tokens after redaction; admin scope is now reserved for mutating operations (`restart`, `abort`, `history/backfill`, `retention`). QA cockpit read-mode e2e verifies verdict/gallery/runs/player remain visible while restart/backfill/purge buttons stay disabled and do not call admin endpoints.
  - Evidence: L1 `bun test runtime/__tests__/qa-story-report.test.ts` PASS `39/39`; `bun run check` PASS; focused QA cockpit e2e PASS `3/3`, run `20260624-134259-361`, wall `30.8s`, benchmark OK vs `20260624-134214-230`.

- [x] Implement `/qa?embed=1` properly or remove it.
  - Impact: medium.
  - Current issue: health embed passes `embed=1`, but route does not honor it.
  - Fix: embed mode hides sidebar/heavy nested iframe controls and shows compact cockpit teaser, or remove the param.
  - Status: removed. The health embed component that passed `/qa?embed=1` was deleted; health now links to `/qa` instead of embedding an unimplemented mode.
  - Tests: health e2e asserts no QA iframe is present.

- [ ] Split `EntityPanelTabs.svelte` into tab-owned components.
  - Impact: medium-high.
  - Current issue: the file is over 8k lines and keeps absorbing unrelated feature diffs.
  - Fix: move Accounts, Reserves, Swaps, J-events, External Wallet, and remote/runtime sections into `Entity/tabs/*.svelte` with a thin parent and shared typed stores.
  - Tests: smoke each tab with existing fixtures; no behavior change in active entity selection.
  - Progress: first assets-owned extraction done. Asset ledger rows/totals moved into `AssetLedgerTable.svelte` with shared `asset-ledger.ts` types; parent still owns data derivation/actions.
  - Evidence: L1 `bun run check:frontend` PASS with `svelte-check 0 errors / 0 warnings`; L2 focused move-direct browser flow PASS `1/1`, run `20260624-154004-542`, wall `16.5s`, code hash `df2ed2f3f97b6dc1`, benchmark OK.
  - Progress: second assets-owned extraction done. Faucet selector/actions moved into `AssetFaucetCard.svelte`; parent still owns selected symbol and faucet submission side effects.
  - Evidence: L1 `bun run check:frontend` PASS with `svelte-check 0 errors / 0 warnings`; L2 focused move-direct browser flow PASS `1/1`, run `20260624-154411-170`, wall `17.0s`, code hash `e76441fa4ea4fa6c`, benchmark OK vs `20260624-154004-542`.
  - Progress: third assets-owned extraction done. External EOA/source metadata moved into `AssetWalletMeta.svelte`; shared snapshot source type moved into `asset-ledger.ts`; generic content button override now excludes asset action buttons.
  - Evidence: L1 `bun run check:frontend` PASS with `svelte-check 0 errors / 0 warnings`; L2 focused move-direct browser flow PASS `1/1`, run `20260624-154751-725`, wall `16.6s`, code hash `e182691a8ac002c5`, benchmark OK vs `20260624-154411-170`.
  - Progress: fourth extraction done. Shared debt/pending batch banner moved into `PendingBatchNotice.svelte`, replacing duplicate Assets and Accounts markup while preserving separate history handlers and debt notes.
  - Evidence: L1 first exposed an implicit `string | null` mode type and then passed after source typing; L2 focused move routed-path browser flow PASS `1/1`, run `20260624-155300-762`, wall `32.7s`, code hash `129dd604efcaa79c`, benchmark OK with host-load-only delta. Updated three move batch UX gallery PNGs from the e2e run.
  - Progress: fifth extraction done. Repeated account workspace empty-state markup moved into `LiveRequiredState.svelte`; parent keeps only the mode conditions.
  - Evidence: L1 `bun run check:frontend` PASS with `svelte-check 0 errors / 0 warnings`; L2 focused move routed-path browser flow PASS `1/1`, run `20260624-155713-677`, wall `31.7s`, code hash `47745f57390a040e`, benchmark OK vs `20260624-155300-762`.
  - Progress: sixth extraction done. Account manage tab navigation moved into `ConfigureWorkspaceTabs.svelte`; parent keeps form rendering and selected-tab state only.
  - Evidence: L1 `bun run check:frontend` PASS with `svelte-check 0 errors / 0 warnings`; L2 focused UI screenshot browser flow PASS `1/1`, run `20260624-160118-721`, wall `31.4s`, code hash `241c8b94ecb691be`, benchmark insufficient because no previous comparable run. Regenerated gallery PNGs were restored because the nav extraction is visually identical and the PNG deltas were rerun churn.
  - Progress: current file-size phase done. Account selector, hero tabs, activity, open-account, configure-account, appearance, assets, and pending-batch preview logic moved into dedicated `Entity/*` components/helpers. `EntityPanelTabs.svelte` is now 4,875 lines.
  - Evidence: `bun run check` PASS; frontend file-size gate PASS; `svelte-check 0 errors / 0 warnings`; focused isolated e2e `20260624-163027-981` PASS `2/2`, wall `33.5s`, HEAD `b5d6a96c092f`, code hash `804dc251bee8d69d`. The run covers BrowserVM/Graph3D visual path plus desktop/mobile main-tab screenshots. Browser issues: `0` errors, only WebGL driver `ReadPixels` perf warnings.
  - Progress: seventh extraction done. Deep-link route parsing and tab/subview reducer moved into `entity-panel-routing.ts`; `EntityPanelTabs.svelte` now only applies the typed update to Svelte state and is down to 4,772 lines.
  - Evidence: L1 `bun test tests/frontend/entity-panel-routing.test.ts` PASS `5/5`; `bun run check:frontend` PASS with `svelte-check 0 errors / 0 warnings`; focused `/app#pay` deep-link e2e `20260624-165103-048` PASS `1/1`, wall `19.4s`, code hash `2042b9393cd84e77`, browser errors `0`.
  - Progress: eighth extraction done. Move visual DOM refs, anchor measurement, RAF scheduling, ResizeObserver ownership, and committed-line timer logic moved into `move-visual-controller.ts`; `EntityPanelTabs.svelte` is down to 4,649 lines.
  - Evidence: L1 `bun test tests/frontend/move-visual-controller.test.ts` PASS `2/2`; `bun run check:frontend` PASS with `svelte-check 0 errors / 0 warnings`; focused move direct e2e `20260624-165805-576` PASS `1/1`, wall `16.6s`, code hash `ed1aa5bb210065aa`.
  - Progress: ninth extraction done. Entity jurisdiction resolution and compact display helpers moved into `entity-panel-model.ts` and `entity-panel-display.ts`; `EntityPanelTabs.svelte` is down to 4,591 lines.
  - Evidence: L1 `bun test tests/frontend/entity-panel-model.test.ts tests/frontend/entity-panel-display.test.ts` PASS `6/6`; `bun run check:frontend-file-size` PASS; `bun run check:frontend` PASS with `svelte-check 0 errors / 0 warnings`; focused jurisdiction settings e2e `20260624-171948-551` PASS `1/1`, wall `11.4s`, code hash `fed66efe85fb9db9`.
  - Progress: tenth extraction done. Open-account entity options, move entity options, move source account options, and full-entity-id validation moved into `entity-panel-options.ts`; `EntityPanelTabs.svelte` is down to 4,573 lines.
  - Evidence: L1 `bun test tests/frontend/entity-panel-options.test.ts` PASS `4/4`; `bun run check:frontend-file-size` PASS; `bun run check:frontend` PASS with `svelte-check 0 errors / 0 warnings`; focused move routed-path e2e `20260624-172318-278` PASS `1/1`, wall `32.7s`, code hash `90e6d9e75d47683f`, browser errors `0`, browser warnings `8` all `GOSSIP_PROFILE_MISS` retry warnings.
  - Progress: eleventh extraction done. External wallet snapshot types, strict field/count validation, optional token-id normalization, finality-depth validation, and snapshot source reading moved into `external-wallet-snapshot.ts`; `EntityPanelTabs.svelte` is down to 4,497 lines.
  - Evidence: L1 `bun test tests/frontend/external-wallet-snapshot.test.ts` PASS `4/4`; `bun run check:frontend-file-size` PASS; `bun run check:frontend` PASS with `svelte-check 0 errors / 0 warnings`; focused move routed-path e2e `20260624-172754-468` PASS `1/1`, wall `30.6s`, code hash `fb32b1577c4338ae`, benchmark OK vs `20260624-172318-278`, browser errors `0`, browser warnings `8` all `GOSSIP_PROFILE_MISS` retry warnings.
  - Progress: twelfth extraction done. Entity asset amount formatting, compact USD labels, reserve/external value math, and account portfolio totals moved into `entity-asset-values.ts`; `EntityPanelTabs.svelte` is down to 4,451 lines.
  - Evidence: L1 `bun test tests/frontend/entity-asset-values.test.ts` PASS `4/4`; `bun run check:frontend-file-size` PASS; `bun run check:frontend` PASS with `svelte-check 0 errors / 0 warnings`; focused move routed-path e2e `20260624-173426-679` PASS `1/1`, wall `31.7s`, code hash `86d1c8bbe6c3391a`, benchmark OK vs `20260624-172754-468`, browser errors `0`, browser warnings `8` all `GOSSIP_PROFILE_MISS` retry warnings.
  - Progress: thirteenth extraction done. External/reserve asset token types, UI token ordering, case-insensitive asset lookup, reserve-transfer resolution, faucet reserve metadata, and required-token fail-fast lookup moved into `entity-asset-catalog.ts`; `EntityPanelTabs.svelte` is down to 4,392 lines.
  - Evidence: L1 `bun test tests/frontend/entity-asset-catalog.test.ts` PASS `4/4`; `bun run check:frontend-file-size` PASS; `bun run check:frontend` PASS with `svelte-check 0 errors / 0 warnings`; focused move routed-path e2e `20260624-173854-618` PASS `1/1`, wall `30.5s`, code hash `eee4062c6388d9be`, benchmark OK vs `20260624-173426-679`, browser errors `0`, browser warnings `8` all `GOSSIP_PROFILE_MISS` retry warnings.
  - Progress: fourteenth extraction done. Asset amount parsing, token input formatting, positive amount validation, and reserve token metadata resolution moved into `entity-asset-values.ts` / `entity-asset-catalog.ts`; `EntityPanelTabs.svelte` is down to 4,366 lines.
  - Evidence: L1 `bun test tests/frontend/entity-asset-values.test.ts tests/frontend/entity-asset-catalog.test.ts` PASS `10/10`; `bun run check:frontend-file-size` PASS; `bun run check:frontend` PASS with `svelte-check 0 errors / 0 warnings`; focused move routed-path e2e `20260624-174355-686` PASS `1/1`, wall `32.6s`, code hash `0273b57cadc6f7bb`, benchmark OK vs `20260624-173854-618`, browser errors `0`, browser warnings `8` all `GOSSIP_PROFILE_MISS` retry warnings.
  - Progress: fifteenth extraction done. Account workspace navigation state transitions for account selection, focused-account return, top-level tab switching, and disputed-account focus moved into `account-workspace-navigation.ts`; `EntityPanelTabs.svelte` is down to 4,351 lines.
  - Evidence: L1 `bun test tests/frontend/account-workspace-navigation.test.ts` PASS `5/5`; `bun run check:frontend-file-size` PASS; `bun run check:frontend` PASS with `svelte-check 0 errors / 0 warnings`; focused move routed-path e2e `20260624-174750-783` PASS `1/1`, wall `32.6s`, code hash `c1157f0e5b090ca9`, benchmark OK vs `20260624-174355-686`, browser errors `0`, browser warnings `8` all `GOSSIP_PROFILE_MISS` retry warnings.
  - Progress: sixteenth extraction done. Pending-batch derived state, broadcast eligibility, and exact global action tx construction moved into `pending-batch-preview.ts`; `EntityPanelTabs.svelte` is down to 4,331 lines.
  - Evidence: L1 `bun test tests/frontend/pending-batch-preview.test.ts` PASS `4/4`; `bun run check:frontend-file-size` PASS; `bun run check:frontend` PASS with `svelte-check 0 errors / 0 warnings`; focused move routed-path e2e `20260624-175325-733` PASS `1/1`, wall `31.4s`, code hash `4f712c3b8dd74c04`, benchmark OK vs `20260624-174750-783`, browser errors `0`, browser warnings `8` all `GOSSIP_PROFILE_MISS` retry warnings.
  - Progress: seventeenth extraction done. Reserve movement, external deposit/withdrawal, open-account, dispute, settlement approval, reopen, add-token, and post-settle follow-up tx construction moved into `entity-action-txs.ts`; `EntityPanelTabs.svelte` is down to 4,220 lines.
  - Evidence: L1 `bun test tests/frontend/entity-action-txs.test.ts tests/frontend/pending-batch-preview.test.ts` PASS `8/8`; `bun run check:frontend-file-size` PASS; `bun run check:frontend` PASS with `svelte-check 0 errors / 0 warnings`; focused move routed-path e2e `20260624-180118-552` PASS `1/1`, wall `31.6s`, code hash `aa3669bb131d5243`, benchmark OK vs `20260624-175325-733`, browser errors `0`, browser warnings `8` all `GOSSIP_PROFILE_MISS` retry warnings.
  - Progress: eighteenth extraction done. Move route draft eligibility, direct-route action labels, and explicit move validation context/error selection moved into `move-routes.ts` and `move-validation.ts`; `EntityPanelTabs.svelte` is down to 4,160 lines.
  - Evidence: L1 `bun test tests/frontend/move-validation.test.ts tests/frontend/entity-action-txs.test.ts` PASS `8/8`; `bun run check:frontend-file-size` PASS; `bun run check:frontend` PASS with `svelte-check 0 errors / 0 warnings`; focused move routed-path e2e `20260624-180654-835` PASS `1/1`, wall `32.6s`, code hash `473b220e66ad4596`, benchmark OK vs `20260624-180118-552`, browser errors `0`, browser warnings `8` all `GOSSIP_PROFILE_MISS` retry warnings.
  - Progress: nineteenth extraction done. Move allowance route requirement, context signature, required allowance amount, satisfaction check, and status label building moved into `move-routes.ts` and `move-allowance.ts`; `EntityPanelTabs.svelte` is down to 4,153 lines.
  - Evidence: L1 `bun test tests/frontend/move-allowance.test.ts tests/frontend/move-validation.test.ts` PASS `8/8`; `bun run check:frontend-file-size` PASS; `bun run check:frontend` PASS with `svelte-check 0 errors / 0 warnings`; focused move routed-path e2e `20260624-181234-162` PASS `1/1`, wall `32.3s`, code hash `5853a31d48cc7b66`, benchmark OK vs `20260624-180654-835`, browser errors `0`, browser warnings `8` all `GOSSIP_PROFILE_MISS` retry warnings.
  - Progress: twentieth extraction done. Move hub options, target-hub fallback, workspace account normalization, and configure-token option selection moved into `entity-panel-options.ts`; `EntityPanelTabs.svelte` is down to 4,121 lines.
  - Evidence: L1 `bun test tests/frontend/entity-panel-options.test.ts tests/frontend/move-allowance.test.ts` PASS `12/12`; `bun run check:frontend-file-size` PASS; `bun run check:frontend` PASS with `svelte-check 0 errors / 0 warnings`; focused move routed-path e2e `20260624-181822-857` PASS `1/1`, wall `30.5s`, code hash `2af2c548daffeeff`, benchmark OK vs `20260624-181234-162`, browser errors `0`, browser warnings `8` all `GOSSIP_PROFILE_MISS` retry warnings.
  - Progress: twenty-first extraction done. Move max amount, preferred source account, current source balance, and preferred move asset selection moved into `move-balance.ts`; `EntityPanelTabs.svelte` is down to 4,104 lines and now sits below `SwapPanel.svelte`.
  - Evidence: L1 `bun test tests/frontend/move-balance.test.ts tests/frontend/entity-panel-options.test.ts` PASS `12/12`; `bun run check:frontend-file-size` PASS; `bun run check:frontend` PASS with `svelte-check 0 errors / 0 warnings`; focused move routed-path e2e `20260624-182305-156` PASS `1/1`, wall `32.5s`, code hash `18e2fa4f04798b37`, benchmark OK vs `20260624-181822-857`, browser errors `0`, browser warnings `8` all `GOSSIP_PROFILE_MISS` retry warnings.
  - Progress: twenty-second extraction done. Disputed-account row derivation, cross-j target dispute risk lookup, and risk label formatting moved into `account-dispute-view.ts`; `EntityPanelTabs.svelte` is down to 4,069 lines and now sits below `SwapPanel.svelte`.
  - Evidence: L1 `bun test tests/frontend/account-dispute-view.test.ts tests/frontend/entity-asset-values.test.ts` PASS `8/8`; `bun run check:frontend-file-size` PASS; `bun run check:frontend` PASS with `svelte-check 0 errors / 0 warnings`; focused dispute lifecycle e2e `20260624-184636-478` PASS `1/1`, wall `29.3s`, HEAD `a9fe4e9a1a12`, code hash `7e2d9e9dec9a8cce`, benchmark `INSUFFICIENT` because no previous comparable dispute lifecycle run exists, browser errors `0`, browser warnings `2`.
  - Progress: twenty-third extraction done. Asset value formatter bundle construction moved into `entity-asset-values.ts`, so `EntityPanelTabs.svelte` no longer owns precision/compact/USD formatter wiring inline; `EntityPanelTabs.svelte` is down to 4,066 lines.
  - Evidence: L1 `bun test tests/frontend/entity-asset-values.test.ts tests/frontend/entity-asset-catalog.test.ts` PASS `11/11`; `bun run check:frontend-file-size` PASS; `bun run check:frontend` PASS with `svelte-check 0 errors / 0 warnings`; focused desktop/mobile main-tabs e2e `20260624-190001-299` PASS `1/1`, wall `32.0s`, HEAD `e38768d77a44`, code hash `84d9ee04e4d2daf0`, benchmark `INSUFFICIENT` because no previous comparable main-tabs screenshot run exists.
  - Progress: twenty-fourth extraction done. Accounts workspace rendering, account list, batch notice, workspace rail, and account subpanel routing moved into `AccountWorkspaceView.svelte`; `EntityPanelTabs.svelte` is down to 3,892 lines.
  - Evidence: L1 `bun test tests/frontend/account-workspace-navigation.test.ts tests/frontend/entity-panel-routing.test.ts` PASS `10/10`; `bun run check:frontend-file-size` PASS; `bun run check:frontend` PASS with `svelte-check 0 errors / 0 warnings`; focused desktop/mobile main-tabs e2e `20260624-191304-192` PASS `1/1`, wall `32.5s`, HEAD `b7fa6cd855c9`, code hash `48a12d8b46db31f4`, benchmark OK vs `20260624-190001-299`, browser issues `0`.
  - Progress: twenty-fifth extraction done. Header chrome, jurisdiction/entity selectors, and historical-state warning moved into `EntityPanelChrome.svelte`; `EntityPanelTabs.svelte` is down to 3,825 lines.
  - Evidence: L1 `bun test tests/frontend/account-workspace-navigation.test.ts tests/frontend/entity-panel-routing.test.ts` PASS `10/10`; `bun run check:frontend-file-size` PASS; `bun run check:frontend` PASS with `svelte-check 0 errors / 0 warnings`; focused desktop/mobile main-tabs e2e `20260624-194303-184` PASS `1/1`, wall `31.2s`, HEAD `cf856672f28c`, code hash `8ccccf2fb2c53158`, benchmark OK vs `20260624-191304-192`, browser issues `0`, max child CPU improved `85.2% -> 49.4%`.
  - Progress: twenty-sixth extraction done. Empty entity selection state and focused account wrapper moved into `EntitySelectionEmptyState.svelte` / `EntityFocusedAccountView.svelte`; `EntityPanelTabs.svelte` is down to 3,801 lines.
  - Evidence: L1 `bun test tests/frontend/account-workspace-navigation.test.ts tests/frontend/entity-panel-routing.test.ts` PASS `10/10`; `bun run check:frontend-file-size` PASS; `bun run check:frontend` PASS with `svelte-check 0 errors / 0 warnings`; focused desktop/mobile main-tabs e2e `20260624-194708-501` PASS `1/1`, browser issues `0`, wall `31.8s`, benchmark flagged Playwright max-child-CPU `49.4% -> 75.8%`; confirm rerun `20260624-194818-300` PASS `1/1`, browser issues `0`, wall `32.4s`, benchmark OK vs `20260624-194708-501`. Historical same-suite CPU peaks were `81.9%` and `85.2%`, so `49.4%` was treated as a low outlier rather than an app regression; browser phase stayed within `2.7%`.
  - Remaining: keep reducing this parent below the limit with real component ownership, not just line pruning. Next cuts should move account form actions and account-tab state machines out of the parent.

- [x] Enforce frontend source file-size invariant in the main check.
  - Impact: high.
  - Requirement: no frontend source file can exceed 5,000 lines; this is now a check-time invariant, not a convention.
  - Status: done. `bun run check` now runs `runtime/scripts/check-frontend-file-size.ts` before the frontend build. The gate scans `frontend/src` `.svelte`, `.ts`, and `.js` files and fails loudly on violations.
  - Evidence: `bun run check` PASS. Largest frontend files after the split are `SwapPanel.svelte` 3,898 lines, `Graph3DPanel.svelte` 3,842 lines, `EntityPanelTabs.svelte` 3,801 lines, and `/qa/+page.svelte` 3,576 lines.

- [x] Move Graph3D pure helpers out of the Svelte panel.
  - Impact: medium.
  - Current issue: `Graph3DPanel.svelte` mixed reserve snapshot parsing and J-machine tx label formatting into the Three.js scene component, making visual debugger changes harder to audit.
  - Status: done. Added `graph3d-helpers.ts` for reserve map/object normalization, total reserve calculation, single-token reserve lookup, and mempool tx label formatting. The BrowserVM/Graph3D visual path remains intact; renderer, scene lifecycle, and BrowserVM behavior were not removed or replaced.
  - Evidence: L1 `bun test tests/frontend/graph3d-helpers.test.ts` PASS `3/3`; `bun run check:frontend` PASS with `svelte-check 0 errors / 0 warnings`; focused BrowserVM/Graph3D e2e `20260624-170344-945` PASS `1/1`, wall `12.8s`, code hash `b62ef19304a2c9f6`, browser errors `0`.
  - Progress: second extraction done. Entity reserve tooltip formatting, reserve badge labels, short-name/Fed flag resolution, and dual-account tooltip text moved into `graph3d-helpers.ts`; `Graph3DPanel.svelte` is down to 4,111 lines and the BrowserVM/Graph3D visual debugger path is unchanged.
  - Evidence: L1 `bun test tests/frontend/graph3d-helpers.test.ts tests/frontend/graph3d-settings.test.ts` PASS `10/10`; `bun run check:frontend-file-size` PASS; `bun run check:frontend` PASS with `svelte-check 0 errors / 0 warnings`; Playwright `/embed` Graph3D smoke PASS with canvas `720x965`, WebGL `true`, dockview `true`, page/console errors `0`, screenshot `/tmp/xln-graph3d-embed-smoke.png`.
  - Progress: third extraction done. Graph scenario timeline parsing moved into `parseGraphScenarioSteps()` in `graph3d-helpers.ts`; `Graph3DPanel.svelte` is down to 4,091 lines and still only owns fetch/state updates for scenario preview.
  - Evidence: L1 `bun test tests/frontend/graph3d-helpers.test.ts tests/frontend/graph3d-settings.test.ts` PASS `11/11`; `bun run check:frontend-file-size` PASS; `bun run check:frontend` PASS with `svelte-check 0 errors / 0 warnings`; Playwright `/embed` Graph3D smoke PASS with canvas `720x965`, WebGL `true`, dockview `true`, page/console errors `0`.
  - Progress: fourth extraction done. Replica lookup wrappers for entity balance tooltips, entity display names, and dual-account connection tooltips moved into `graph3d-helpers.ts`; `Graph3DPanel.svelte` is down to 4,068 lines.
  - Evidence: L1 `bun test tests/frontend/graph3d-helpers.test.ts tests/frontend/graph3d-settings.test.ts` PASS `12/12`; `bun run check:frontend-file-size` PASS; `bun run check:frontend` PASS with `svelte-check 0 errors / 0 warnings`; focused BrowserVM/Graph3D e2e `20260624-185150-017` PASS `1/1`, wall `11.3s`, HEAD `29cba6c89a55`, code hash `3b8672296bb335c0`, benchmark `INSUFFICIENT` because no previous comparable BrowserVM jurisdiction run exists, browser errors `0`, browser warnings `4` all WebGL `ReadPixels` performance warnings.
  - Progress: fifth extraction done. Gossip entity-name lookup, replica signer lookup, reserve-presence detection, and payment-route BFS moved into `graph3d-helpers.ts`; `Graph3DPanel.svelte` is down to 4,003 lines.
  - Evidence: L1 `bun test tests/frontend/graph3d-helpers.test.ts tests/frontend/graph3d-settings.test.ts` PASS `13/13`; `bun run check:frontend-file-size` PASS; `bun run check:frontend` PASS with `svelte-check 0 errors / 0 warnings`; focused BrowserVM/Graph3D e2e `20260624-190432-235` PASS `1/1`, wall `11.3s`, HEAD `5e24cea5c05b`, code hash `fa1ec0a0c133cf69`, benchmark OK vs `20260624-185150-017`, browser errors `0`, browser warnings `4` all WebGL `ReadPixels` performance warnings.
  - Progress: sixth extraction done. FPS/network metrics overlay rendering moved into `Graph3DFpsOverlay.svelte`; `Graph3DPanel.svelte` is down to 3,906 lines. BrowserVM/visual debugger graph path stays intact.
  - Evidence: L1 `bun test tests/frontend/graph3d-helpers.test.ts` PASS `10/10`; `bun run check:frontend-file-size` PASS; `bun run check:frontend` PASS with `svelte-check 0 errors / 0 warnings`; focused BrowserVM/Graph3D e2e `20260624-192909-783` PASS `1/1`, wall `11.3s`, HEAD `cba021ea99c0`, code hash `dabd163262f4cfa5`, benchmark OK vs `20260624-190432-235`, browser errors `0`, browser warnings `4` all WebGL `ReadPixels` performance warnings.
  - Progress: seventh extraction done. Scene/runtime/entity/connection/payment/ripple TypeScript contracts moved into `graph3d-types.ts`; `Graph3DPanel.svelte` is down to 3,842 lines. This is type-only ownership cleanup; renderer, BrowserVM, and visual debugger graph behavior are unchanged.
  - Evidence: L1 `bun test tests/frontend/graph3d-helpers.test.ts tests/frontend/graph3d-settings.test.ts` PASS `13/13`; `bun run check:frontend-file-size` PASS; `bun run check:frontend` PASS with `svelte-check 0 errors / 0 warnings`; focused BrowserVM/Graph3D e2e `20260624-193827-970` PASS `1/1`, wall `11.3s`, HEAD `ed441fe2bef3`, code hash `942b1a92afd33b57`, benchmark OK vs `20260624-192909-783`, browser errors `0`, browser warnings `4` all WebGL `ReadPixels` performance warnings.

- [x] Move Graph3D settings persistence out of the Svelte panel.
  - Impact: medium.
  - Current issue: `Graph3DPanel.svelte` owned localStorage key/default parsing, legacy selected-token normalization, camera snapshot construction, and write serialization inline with Three.js lifecycle code.
  - Status: done. Added `graph3d-settings.ts` for typed settings contracts, default/read/normalize/build/write helpers, while preserving the BrowserVM/Graph3D renderer path.
  - Evidence: L1 `bun test tests/frontend/graph3d-settings.test.ts` PASS `3/3`; `bun run check:frontend-file-size` PASS; `bun run check:frontend` PASS with `svelte-check 0 errors / 0 warnings`; focused BrowserVM/Graph3D e2e `20260624-171449-596` PASS `1/1`, wall `11.3s`, code hash `23ce500129949887`, browser errors `0`, browser warnings `4` all WebGL `ReadPixels` performance warnings.

- [x] Move SwapPanel pure display/orderbook helpers out of the Svelte panel.
  - Impact: medium.
  - Current issue: `SwapPanel.svelte` mixed hub candidate selection, jurisdiction display normalization, pair labels, initials, badge text, token-map lookup, and numeric clamp helpers into the swap UI component.
  - Status: done. Added `swap-panel-helpers.ts` for the pure helper layer and kept `SwapPanel.svelte` focused on Svelte state, runtime reads, and event handlers. `SwapPanel.svelte` is down to 4,119 lines.
  - Evidence: L1 `bun test tests/frontend/swap-panel-helpers.test.ts` PASS `4/4`; `bun run check:frontend-file-size` PASS; `bun run check:frontend` PASS with `svelte-check 0 errors / 0 warnings`; focused swap orderbook dropdown e2e `20260624-171030-362` PASS `1/1`, wall `20.9s`, code hash `41377d1db2b7f14d`, browser errors `0`, benchmark `INSUFFICIENT` because no previous comparable run exists.
  - Progress: second extraction done. Orderbook depth/price/lot/freshness/notional constants, token amount formatting, input amount trimming, price tick parsing, and buy/sell lot requantization moved into `swap-order-math.ts`; `SwapPanel.svelte` is down to 4,082 lines.
  - Evidence: L1 `bun test tests/frontend/swap-order-math.test.ts tests/frontend/swap-panel-helpers.test.ts` PASS `8/8`; `bun run check:frontend-file-size` PASS; `bun run check:frontend` PASS with `svelte-check 0 errors / 0 warnings`; focused swap manual price override e2e `20260624-183724-976` PASS `1/1`, wall `26.4s`, code hash `1d151d54346f27a2`, benchmark `INSUFFICIENT` because no previous comparable run exists.
  - Progress: third extraction done. Same-chain swap form validation input, price-deviation bps math, and deterministic validation ordering moved into `swap-order-math.ts`; `SwapPanel.svelte` is down to 4,024 lines.
  - Evidence: L1 `bun test tests/frontend/swap-order-math.test.ts tests/frontend/swap-panel-helpers.test.ts` PASS `9/9`; `bun run check:frontend-file-size` PASS; `bun run check:frontend` PASS with `svelte-check 0 errors / 0 warnings`; focused swap price-reject e2e `20260624-185520-590` PASS `1/1`, wall `24.5s`, HEAD `85547bf6077c`, code hash `a294df2b2ca1e10f`, benchmark `INSUFFICIENT` because no previous comparable price-reject run exists.
  - Progress: fourth extraction done. Swap completion modal rendering moved into `SwapCompletionDialog.svelte`; `SwapPanel.svelte` is down to 4,006 lines.
  - Evidence: L1 `bun test tests/frontend/swap-order-math.test.ts tests/frontend/swap-panel-helpers.test.ts` PASS `9/9`; `bun run check:frontend-file-size` PASS; `bun run check:frontend` PASS with `svelte-check 0 errors / 0 warnings`; focused swap price-reject e2e `20260624-191743-590` PASS `1/1`, wall `25.4s`, browser issues `0`, but benchmark flagged one nonpersistent `max child CPU` spike (`49.2% -> 76.4%`). Immediate rerun `20260624-191840-390` PASS `1/1`, wall `23.4s`, max child CPU `47.3%`, benchmark OK.
  - Progress: fifth extraction done. Orderbook market section rendering and browser-safe orderbook UI types moved into `SwapOrderbookSection.svelte` / `swap-orderbook-view.ts`; `SwapPanel.svelte` is down to 3,943 lines.
  - Evidence: L1 `bun test tests/frontend/swap-order-math.test.ts tests/frontend/swap-panel-helpers.test.ts` PASS `9/9`; `bun run check:frontend-file-size` PASS; `bun run check:frontend` PASS with `svelte-check 0 errors / 0 warnings`; focused orderbook pair dropdown e2e `20260624-192407-034` PASS `1/1`, wall `19.8s`, code hash `d7ba9723be496ed1`, browser issues `0`, benchmark `INSUFFICIENT` because no previous comparable pair-dropdown run exists.
  - Progress: sixth extraction done. Route summary, route flow, cross auto-extend controls, price-improvement selector, and manual route recommendation rendering moved into `SwapRouteBuilder.svelte`; `SwapPanel.svelte` is down to 3,898 lines. The cross e2e helper now uses the localhost `window.isolatedEnv` setter instead of importing `/src/lib/stores/runtimeStore.ts`, removing the dev-server 404 browser issue from QA evidence.
  - Evidence: L1 `bun test tests/frontend/swap-order-math.test.ts tests/frontend/swap-panel-helpers.test.ts` PASS `9/9`; `bun run check:frontend-file-size` PASS; `bun run check:frontend` PASS with `svelte-check 0 errors / 0 warnings`; focused cross no-market route-builder e2e `20260624-193449-543` PASS `1/1`, wall `16.8s`, code hash `245d9563c84567cd`, browser issues `0`, benchmark OK vs `20260624-193238-803`.

- [x] Move QA cockpit API/UI types out of the Svelte route.
  - Impact: medium-high.
  - Current issue: `/qa/+page.svelte` redeclared the QA API contract locally, and importing the server report module directly into the frontend would pull `bun:sqlite` into the browser type graph.
  - Status: done. Added browser-safe `runtime/qa/types.ts` for shared QA contracts and a thin `$lib/qa/types.ts` for UI-only cockpit types. `/qa/+page.svelte` now imports those contracts instead of carrying 500 lines of duplicate type declarations. The isolated e2e runner also imports type-only QA contracts from `runtime/qa/types.ts` while keeping server functions in `runtime/qa/report.ts`.
  - Evidence: `bun x tsc -p tsconfig.runtime.json --noEmit` PASS; `bun run check:frontend` PASS with `svelte-check 0 errors / 0 warnings`; `bun test runtime/__tests__/qa-story-report.test.ts` PASS `42/42`; focused QA cockpit e2e `20260624-163926-929` PASS `1/1`, wall `10.2s`, code hash `7675ff0595bcdbc1`.

- [x] Move QA cockpit pure helpers out of the Svelte route.
  - Impact: medium-high.
  - Current issue: `/qa/+page.svelte` still owned formatting, browser-health summaries, failure inbox derivation, run sorting, verdict synthesis, and phase-waterfall math even after type extraction.
  - Status: done. Added `$lib/qa/cockpit-helpers.ts` for pure cockpit helpers; `/qa/+page.svelte` now keeps Svelte state, IO, and event handlers while importing reusable helpers for labels, health, failure inbox, sorting, verdicts, and phase waterfall display. Route size is down to 3,663 lines.
  - Evidence: `bun run check:frontend-file-size` PASS; `bun run check:frontend` PASS with `svelte-check 0 errors / 0 warnings`; focused QA cockpit e2e `20260624-164605-359` PASS `1/1`, wall `9.5s`, code hash `e7d564c4d7899eb2`, benchmark OK vs `20260624-163926-929`.

## p2 performance and scale

- [x] Make `listQaHistory` pure SELECT on the hot path.
  - Impact: high.
  - Current issue: history endpoint re-read and upserted manifests from disk on every poll.
  - Status: done. `/api/qa/history` is now SQLite SELECT-only; run completion still records history once; legacy manifest ingestion moved to explicit admin POST `/api/qa/history/backfill` with confirm `BACKFILL_QA_HISTORY`.
  - Extra: `/api/qa/runs` no longer performs heavy `readQaRun()` reads on the normal DB-backed path.
  - UI: History tab has a disabled-without-admin `Backfill History Index` maintenance action and result counters.
  - Evidence: unit first failed on implicit manifest backfill, then passed with GET-only history and explicit admin backfill; focused QA cockpit e2e verifies the visible backfill action/result.

- [x] Add manual retention cleanup for old QA runs.
  - Impact: medium.
  - Product decision: store all runs by default. Add a manual admin action to delete run logs/history older than 30 days when explicitly requested.
  - Status: done. `/api/qa/retention` requires admin POST and exact confirm `DELETE_OLDER_THAN_30_DAYS`; History tab exposes the disabled-by-default control and result count.
  - Evidence: unit deletes only a controlled fake run older than cutoff; focused QA cockpit e2e verifies disabled state, exact confirm, POST, and result rendering.

- [x] Strip `perf.samples` from default `/api/qa/run` payload.
  - Impact: high.
  - Current issue: per-second samples were shipped and mostly discarded by UI.
  - Status: done. `/api/qa/runs` and `/api/qa/run` now serialize perf summaries without raw `samples`; `/api/qa/run/perf?runId=...` returns raw run and shard samples only when requested.
  - Evidence: unit asserts default run payload strips run/shard samples while the perf endpoint returns the raw timeseries; QA cockpit fixture now mirrors the lean run contract.

- [x] Strip `perf.samples` from QA history `manifest_json`.
  - Impact: medium.
  - Current issue: SQLite history rows stored the full per-second sample arrays even though benchmark comparison and run ledger only need summaries.
  - Status: done. `recordQaRunHistory()` persists sample-stripped run/shard perf blobs; raw samples remain in the run-dir manifest and `/api/qa/run/perf` path.
  - Evidence: unit reads SQLite `manifest_json` directly and verifies run/shard `sampleCount` is retained while `samples` is empty.

- [x] Add ETag or shared polling store for QA/health data.
  - Impact: medium.
  - Current issue: multiple panels polled overlapping endpoints every 15 seconds and re-downloaded unchanged JSON.
  - Status: done. QA JSON GET endpoints now emit strong content ETags and return `304` on matching `If-None-Match`; media endpoints stay uncached. `qaFetch()` keeps an in-memory per-token response cache and transparently serves cached JSON bodies on 304.
  - Coverage: catalog/history/restart status/restart audit/stories/runs/run/perf use `private, no-cache` ETags; POST/admin actions stay `no-store`.
  - Evidence: backend unit asserts ETag/304 contract; frontend integration test uses a real Bun server to verify `qaFetch()` sends `If-None-Match` and returns cached JSON on 304.

- [x] Keep 1M-account remote snapshots aggregate-first.
  - Impact: high.
  - Requirement: server returns small snapshots; frontend drill-down is cursor/page based.
  - API: counts, hashes, sample IDs, top deltas, pagination cursors, not full arrays.
  - Tests: 1M fake hub snapshot stays under 100KB and renders under 100ms without main-thread freeze.
  - Status: done. Current-height `view-frame` and paged account/book reads now prefer persisted storage pages when the persisted head can serve the requested height; live env projection is only fallback for unpersisted/local reads.
  - Evidence: L1 `runtime adapter 1M account view-frame stays aggregate-first and under wire budget` uses a fake 1M hub, returns 10 visible accounts plus `summary.totalItems`, cursors, sample IDs, state hashes, and top deltas; encoded response stays below 100KB and resolves under 100ms.

- [x] Virtualize large run/shard/artifact lists.
  - Impact: medium.
  - Tests: 200+ shard run remains responsive; no layout shift on hover/status changes.
  - Status: done. QA cockpit now windows runs, history rows, canonical ledger rows, suite shards, and non-media evidence artifacts behind explicit `Show more` controls instead of rendering the whole run at once.
  - Evidence: focused QA cockpit e2e `20260624-141128-750` PASS `1/1`, wall `9.2s`, code hash `ed3ed21412cc6f36`; validates 240 shards render 80 -> 160 -> 240 and 90 artifacts render 40 -> 80 -> 90. Browser event capture stayed clean: no 404/console error file emitted.

## p2 data quality and simplification

- [x] Replace heuristic scenario metadata with authored metadata.
  - Impact: medium.
  - Current issue: handles/descriptions/summaries are partly inferred with regex and word truncation.
  - Fix: `targets.json` or scenario manifest contains `handle`, `title`, `summary10w`, `description`, `steps[]`, `owner`, `severityPolicy`.
  - Tests: known golden scenarios preserve handle/summary exactly.
  - Status: done. QA report parsing now preserves authored `scenario.summary10w`, `steps[]`, `owner`, and `severityPolicy` from `targets.json`/manifest while keeping old heuristic fallback for legacy runs. QA Scenario Player and preview cards prefer authored summaries and authored video-clock cues when real timestamps exist.
  - Evidence: L1 `bun test runtime/__tests__/qa-story-report.test.ts` PASS `39/39`; L2 isolated QA cockpit e2e PASS `1/1`, run `20260624-133006-710`, wall `12.9s`, code hash `54e9e8749fc2b1fb`.

- [x] Remove duplicated media blocks; Scenario Player owns video/screenshots.
  - Impact: medium.
  - UI: QA detail page has one player and one right-side evidence panel.
  - Status: done. QA shard detail now treats `video`, `image`, and `qa-cues` artifacts as Scenario Player-owned. The right panel shows only non-media evidence files, so the operator sees one canonical video/screenshot/transcript surface.
  - Evidence: `bun run check` PASS; focused QA cockpit e2e PASS `1/1`, run `20260624-133405-526`, wall `12.6s`, benchmark OK vs `20260624-133006-710`.

- [x] Merge overlapping Runs/Suites/Benchmarks surfaces.
  - Impact: medium.
  - UI: one Runs ledger with category chips: unit, contract, e2e, benchmark, scenario. Benchmarks tab should chart bench metrics, not duplicate history rows.
  - Status: done. `Runs Ledger` is now the canonical run surface with category chips and shared speed/date sorting; `Database` owns persistent history, retention, backfill, and restart audit only. `Benchmarks` keeps benchmark commands plus regression comparator and a compact wall/load/cpu/browser/bench trend, without duplicating the history table.
  - Evidence: L1 `bun run check:frontend` PASS with `svelte-check 0 errors / 0 warnings`. Focused QA cockpit e2e `20260624-152023-776` PASS `5/5`, wall `17.8s`, code hash `e1bed4acbb1f2031`, benchmark OK vs `20260624-151932-222`. First rerun `20260624-151932-222` failed only on stale short-hash assertions after UI moved to git-style 8-char hashes; assertions were updated.

- [x] Collapse raw log tail by default and show structured summary first.
  - Impact: medium.
  - UI: raw logs behind explicit expand/open artifact. Summary shows severity, failure class, fatal marker, browser/network errors.
  - Status: done. QA shard detail now opens on an Evidence Summary with status, failure class, browser health, fatal marker, and primary error; raw log tail is hidden behind `Show raw log tail` plus the protected full-log artifact button.
  - Evidence: L1 `bun test runtime/__tests__/qa-story-report.test.ts` PASS `38/38`; focused QA cockpit e2e `20260624-131548-261` PASS `1/1`, wall `12.2s`, code hash `a49c66059e94f9b6`, benchmark OK. Fixture verifies fatal/primary-error summary and raw-log expand/collapse.

- [x] Stop using future/test run IDs that pollute history.
  - Impact: medium.
  - Tests: Playwright should route fixtures or use temp DB/log root, never persistent future `.logs` entries.
  - Status: done. QA report tests now delete their disposable history rows before and after the test that records a synthetic run; the existing QA cockpit Playwright fixture remains API-routed and does not persist its mocked run IDs.
  - Evidence: L1 `bun test runtime/__tests__/qa-story-report.test.ts` PASS `38/38`; focused QA cockpit e2e `20260624-131940-545` PASS `1/1`, wall `12.2s`, code hash `a88373a7348b7a59`, benchmark OK. SQLite check after both runs returned `[]` for `20000101-000000-123`, `20260623-235959-999`, and `20260623-225959-888`.

- [x] Fix remote orderbook compact depth.
  - Impact: low-medium.
  - Current issue: compact view recomputes `totalQtyLots` from selected first 20 orders only.
  - Fix: preserve source level total while still truncating visible order IDs.
  - Tests: level with 25 orders shows full depth and only 20 visible orders.
  - Status: done. Remote radapter compact book views now trim visible `orderIds`/orders for browser payload size but keep canonical `PriceLevelState.totalQtyLots` from the source book level.
  - Evidence: L1 `bun test runtime/__tests__/radapter.test.ts` PASS `39/39`; regression first failed with `Expected: 25n, Received: 20n`, then passed with 20 visible orders and full level depth `25n`.

- [x] Decide strict `0x` RPC result behavior for external wallet snapshots.
  - Impact: low.
  - Current issue: strict bigint parse fails on empty `0x`.
  - Decision: for token calls, invalid result should identify bad token and degrade that token, not 500 the whole dashboard, unless release gate requires fail-fast.
  - Tests: non-contract token returns structured token error.
  - Status: done. Native balance reads stay fail-fast, while ERC20 balance/allowance read failures return structured `tokenErrors`/`allowanceErrors`. The API response keeps the bad token visible with an error, canonical `ExternalWalletSnapshot` only applies valid token/allowance entries, and the Assets ledger shows `Read error` instead of silently treating a broken token read as ordinary zero.
  - Evidence: L1 `bun test runtime/__tests__/jadapter-helpers.test.ts` PASS `15/15`; L1 `bun test runtime/__tests__/external-wallet-api.test.ts` PASS `5/5` with a non-contract token returning structured error and no fake zero applied to the canonical event.

- [x] Align stale `RequiredBrowserVM.approveErc20` type.
  - Impact: low.
  - Current issue: helper type says `Promise<string>` while core adapter returns `Promise<JEvent[]>`.
  - Status: done. Scenario helper now derives `approveErc20` from `JAdapter['approveErc20']`, so return type/options cannot drift from the adapter contract again.
  - Evidence: runtime TypeScript gate covers the helper/interface alignment.
  - Fix: update scenario helper type and decide whether callers apply returned deltas or intentionally discard them.
  - Tests: TypeScript catches incompatible adapter.

## security backlog

- [x] Add token redaction to log tail/artifact rendering.
  - Redact bearer tokens, `xlnra1.`, private keys, mnemonics, auth seeds, RPC URLs with credentials, and token-bearing import URLs.
  - Status: done. QA manifests now store redacted `logTail/error`, legacy reads redact old raw tails, and `/api/qa/artifact` redacts text/json/vtt/log responses while leaving binary media byte-for-byte.
  - Evidence: unit covers direct redactor cases plus a real QA run fixture where manifest tail, error, and text artifact all hide stored secrets.

- [x] Add artifact sensitivity classification.
  - Artifacts: public, internal, secret-bearing. Secret-bearing artifacts require admin scope or are unavailable in regulator export.
  - Status: done. Runner and report reader classify artifacts as `public`, `internal`, or `secret-bearing`; legacy manifests are enriched on read. `/api/qa/artifact` now denies secret-bearing files to read tokens and requires admin scope, while cue transcripts stay public and videos/screenshots stay internal.
  - Evidence: `bun test runtime/__tests__/qa-story-report.test.ts` covers classifier decisions plus read/admin artifact access; `bun x tsc -p tsconfig.runtime.json --noEmit` passes.

- [x] Hide absolute server paths from operator UI.
  - Status: done. Restart active status and restart audit rows now expose relative `.logs/...` IDs, not `/Users/...` or other host paths; legacy absolute DB rows are normalized on read.
  - Evidence: unit writes a legacy absolute restart log path and asserts the API-facing audit row hides `process.cwd()`; live restart response also exposes only `.logs/qa-restarts/...`.

- [x] Add restart cooldown and watchdog.
  - Status: done. Restart run now has explicit single-flight 409, post-finish cooldown 429, watchdog timeout, SIGTERM then SIGKILL grace, manual admin abort endpoint, and orphaned audit reconciliation for stale `started` rows.
  - UI: QA catalog shows active restart, terminating status, watchdog budget, and cooldown reason chips.
  - Evidence: unit starts a lightweight real child process, proves concurrent run returns 409 without spawning a second process, proves watchdog marks `watchdog_timeout` and frees the active slot, and proves cooldown returns 429 without spawning.

- [x] Split `restartStatus()` into pure getter and explicit reaper.
  - Status: done. `readQaRestartStatus()` is a side-effect-free status reader; `reapQaRestartState()` performs explicit lifecycle transitions before API responses.
  - Evidence: restart unit coverage exercises active, terminating, inactive, watchdog, and cooldown transitions through the API.

- [x] Confirm destructive/admin actions.
  - Status: done. Restart run requires operator, reason, expected HEAD, and typed `RUN`; retention purge requires typed `DELETE_OLDER_THAN_30_DAYS`; history backfill now requires typed `BACKFILL_QA_HISTORY`; active restart abort is exposed in the Suites view and requires typed `ABORT_RESTART`. Read mode keeps privileged actions visible but disabled.
  - Evidence: focused QA cockpit e2e PASS `2/2`, run `20260624-140459-671`, verifies backfill disabled until typed confirm and verifies active restart abort disabled until `ABORT_RESTART`, then confirms the abort endpoint receives that exact phrase. `bun run check:frontend` PASS with `svelte-check 0/0`.

## missing tests

- [x] Unit: manifest ingest preserves timeline order and derives slow steps sorted.
- [x] Unit: severity classifier.
  - Status: done. `qa-story-report` covers legacy severity normalization, benchmark severity, v3 release schema rejection, and restart audit severity.
- [x] Unit: failure-class classifier.
- [x] Unit: regression threshold math against same code hash and previous HEAD.
- [x] Unit: UTC formatter and runId timezone round-trip.
- [x] API: restart target sanitizer rejects invalid target, self-target, null byte, and traversal.
- [x] Unit: `resolveQaArtifactPath` traversal and symlink escape rejection.
- [x] Unit: `listQaHistory`/`/api/qa/runs` hot path is SQLite-only after backfill.
- [x] Unit: run payload strips `perf.samples`.
- [x] API: QA read token can list runs/artifacts but cannot restart.
- [x] API: admin restart requires operator id, reason, expected HEAD, and confirm.
- [x] API: restart disabled returns 403 and invalid mode returns 400.
- [x] API: concurrent restart returns 409 without spawning a heavy real e2e run.
- [x] API: artifact endpoints are same-origin and token-gated.
- [x] API: audit row written for restart start and updated on finish.
- [x] E2E: `/qa?runId=...&shard=...` deep-link selects exact run and video shard.
  - Status: done. QA cockpit now treats `shard` as the actual manifest shard number, applies it on run load, and keeps `runId/shard` in the URL when a shard or failure class is selected.
  - Evidence: focused QA cockpit e2e fixture has two shards and opens `/qa?runId=20260623-235959-999&shard=7`; the test asserts shard `7` is selected instead of the failed/default shard and that its video path remains playable.
- [x] E2E: failed run opens directly to failed shard and first failure cue.
  - Status: done. Failure Inbox clicks now select the failed shard, keep `runId/shard` in the URL, add a first-class `Failure` transcript cue from the shard error/log, and seek the scenario video to that cue once metadata is ready.
  - Evidence: focused QA cockpit e2e asserts the failed shard `1` is selected, the active transcript cue is marked `data-failure-cue="true"`, the cue text contains the fixture assertion failure, and video currentTime seeks to the failure cue.
- [x] E2E: missing video shows stable empty state with no console errors.
  - Status: done. QA cockpit fixture includes a passed shard with no video artifacts; the Scenario Player renders `No recorded video for this shard` without mounting video or subtitle track elements.
  - Evidence: focused QA cockpit e2e `20260624-003232-055` asserts `qa-video-missing`, `qa-video-player` count `0`, `qa-video-track` count `0`, and no new browser runtime errors.
- [x] E2E: scenario transcript cue scrubs video to real marker timestamp.
  - Status: done. QA cockpit fixture renders authored cue text on real video-clock cue `30ms-60ms`; clicking that transcript cue seeks the `<video>` currentTime to the marker offset instead of synthetic phase time.
  - Evidence: focused QA cockpit e2e PASS `3/3`, run `20260624-134259-361`; assertion checks cue text `Select recorded shard`, `30ms-60ms`, and `currentTime >= 0.02` after clicking the cue.
- [x] E2E: verdict banner shows FAIL on failed fixture and PASS on green fixture.
- [x] E2E: history compare renders deltas and regression badge.
- [x] E2E: restart run disabled in read mode and enabled only in admin mode.
  - Status: done. Read-mode QA fixture keeps verdict, gallery, runs, and player visible but verifies restart/backfill/retention controls are disabled and do not call admin endpoints. Admin/open fixture verifies `Restart run` stays disabled before plan/confirm, then becomes enabled only after a restart plan fills expected HEAD and the operator enters operator id, reason, and `RUN`.
  - Evidence: focused QA cockpit e2e PASS `3/3`, run `20260624-134259-361`, wall `30.8s`.
- [x] E2E: 1M account health snapshot renders aggregate view without freezing.
  - Status: done. `/health` Runtime Adapter panel now renders aggregate account totals, page/cursor state, sample IDs, page hashes, and top deltas while keeping the DOM row count bounded to the visible account page.
  - Evidence: L1 `bun test runtime/__tests__/radapter.test.ts --test-name-pattern "1M account view-frame"` PASS `1/1`; focused radapter e2e `20260624-141628-013` PASS `1/1`, wall `9.3s`, code hash `9252fd58e32cf351`; browser test asserts `1,000,000` total accounts, `10` visible rows, page `1/100,000`, cursor available, state hashes/top deltas, and view-frame wire payload under `100KB`.
- [x] Failure fixtures: browser console error, pageerror, network 502, fatal log marker, phase budget exceeded, corrupt manifest, empty logs dir.
  - Status: done. QA report fixtures now cover browser console assertion errors, pageerror crashes, request failures, HTTP 502 infra failures, fatal runtime log markers, phase-budget breaches, corrupt manifests, and empty legacy run directories.
  - Behavior: corrupt `manifest.json` no longer breaks the QA catalog; it is surfaced as a failed redacted `qa.corrupt-manifest` run with `failureClass=infra`.
  - Evidence: L1 `bun test runtime/__tests__/qa-story-report.test.ts` PASS `42/42`.
- [ ] Golden regulator scenarios: baseline mesh reserves, payment smoke, multi-hop HTLC, dispute lifecycle return, reserve faucet, rebalance, market-maker order placement.

## ideal 1-month UX

- [x] `/health` opens to one verdict: `READY`, `DEGRADED`, or `FAIL`, with exact blocking reason, data age, source height, code hash, and owner.
  - Status: done. The health readiness banner now renders one operator verdict plus blocking reason, payload age, source runtime height, code hash, and owner. `/api/health` refreshes child hub/MM health with a bounded response window so the banner does not depend on stale readiness-cache data.
  - Fix: `normalizeHealthData()` preserves the backend `source` payload; the prior UI dropped `source.height/codeHash` even though backend/redaction already returned it.
  - Evidence: L1 `bun run check:frontend` PASS with `svelte-check 0 errors / 0 warnings`; `bun x tsc -p tsconfig.runtime.json --noEmit` PASS; `bun test runtime/__tests__/health-admin-isolation.test.ts` PASS `1/1`. Focused e2e `20260624-143132-199` PASS `1/1`, wall `10.1s`, code hash `b9299a48e6e467f2`, browser health `0` issues. Benchmark recovered from the failed timeout run: browser test `33154ms -> 4131ms` (`-87.54%`).
- [x] Bootstrap timeline shows preflight, hub mesh, same-chain, cross-chain, market maker, custody, health poll, ready hash, budget vs actual, backlog, and last event.
  - Status: done. `/api/health` now emits a compact `bootstrapTimeline` with stage status/reason/evidence, budget vs actual timings, health-poll timing, ready hash fields when MM is enabled, aggregate backlog counts, and a safe last event. The UI renders it above the detailed BootstrapLive stage grid.
  - Security/perf: public health keeps `readyHash` and aggregate counts but strips runtime/entity state hashes and queued tx details; bootstrap event ingestion reads only a bounded JSONL tail.
  - Evidence: L1 `bun x tsc -p tsconfig.runtime.json --noEmit` PASS; `bun test runtime/__tests__/health-redaction.test.ts` PASS `4/4`; `bun run check:frontend` PASS with `svelte-check 0 errors / 0 warnings`. Focused e2e `20260624-144548-959` PASS `1/1`, wall `10.1s`, code hash `fceb8ca027a4744e`, browser health `0` issues. Benchmark recovered from timeout regression: browser test `33263ms -> 4268ms` (`-87.17%`); host load rose but app timings stayed green.
- [x] `/qa` feels like a regulator-grade video evidence system: run playlist left, video center, real transcript right, failed cue highlighted, artifacts below.
  - Status: done. Selected run evidence now renders as a regulator watch surface: left `Evidence Playlist` with recorded scenario thumbnails/status/video counts, center protected scenario video, right real synced transcript inside the player, and non-media artifacts below playback as a separate evidence shelf. Failed cues remain highlighted and failure inbox still seeks to the failed cue.
  - Evidence: L1 `bun run check:frontend` PASS with `svelte-check 0 errors / 0 warnings`. Focused QA cockpit e2e `20260624-152657-201` PASS `5/5`, wall `18.5s`, code hash `c21059ff5915d1b4`, benchmark OK vs `20260624-152522-801`. E2E verifies playlist presence/selected state, artifact shelf label, protected video/blob track, and desktop geometry proving transcript is to the right of video.
- [x] `/runs` is a ledger across unit, contract, e2e, scenario, benchmark, and release gates.
  - Status: done. Added a standalone `/runs` operator surface backed by `/api/qa/runs`: summary counters, read-token entry, category chips, date/speed/browser sorting, searchable run/suite/owner/hash/audit fields, benchmark/browser/network columns, code/head short hashes, artifact totals, dirty/audit badges, and deep links back to `/qa?runId=...`.
  - Evidence: L1 `bun run check:frontend` PASS with `svelte-check 0 errors / 0 warnings`. Focused QA cockpit e2e `20260624-153309-847` PASS `6/6`, wall `19.5s`, code hash `ae25b38bf4a047a4`, benchmark OK vs `20260624-153148-183`. First run exposed a real search gap for `auditAction=release-gate`; fixed by indexing audit action in `/runs` search.
- [ ] `/ops` is gated and audited: release gate, bootstrap soundcheck, MM soak, shard rerun, restart.
- [ ] Every chart compares current vs same-codeHash baseline, previous HEAD, and last green.
- [x] Centralize system constants in one typed registry so budgets, limits, polling intervals, and UI labels do not drift across orchestrator/runtime/frontend.
  - User-confirmed 2026-06-24: keep system constants in one place for operator/developer convenience.
  - Status: done for the active operator surfaces. `runtime/constants.ts` now includes typed `DISPLAY`, `REMOTE_RUNTIME`, and `QA` registries for compact 4-byte hash display, endpoint trimming, health graph preview, R-adapter page/history/import limits, QA window sizes, confirm phrases, retention/backfill limits, phase budgets, log-tail/timeline caps, and bootstrap evidence preview caps.
  - Evidence: `bun run check:frontend` PASS with `svelte-check 0 errors / 0 warnings`; `bun x tsc -p tsconfig.runtime.json --noEmit` PASS; `bun test runtime/__tests__/qa-story-report.test.ts` PASS `42/42`; `bun test tests/frontend/remote-runtime-import.test.ts` PASS `3/3`.
- [ ] Remote runtime state is always aggregate/cursor/hash based; no full 1M arrays in browser.
- [ ] Regulator export produces one evidence bundle: health snapshot, run ledger, videos, WebVTT, hashes, audit trail, failure explanations, and redacted artifacts.

## recommended build order

1. Secure the QA surface: auth, CORS, restart audit, env allowlist, token redaction.
2. Make evidence honest: real WebVTT cue timestamps, browser/network error capture, failure class.
3. Make the ledger canonical: SQLite-first runs/history, no hot-path manifest re-ingest, regression comparator.
4. Make it regulator-readable: verdict banner, failure inbox, phase waterfall, UTC timestamps.
5. Make it scale-safe: strip perf samples by default, aggregate 1M snapshots, virtualized lists.
6. Clean up UX debt: embed mode, metadata source of truth, remove duplicate views, collapse raw logs.

## after core backlog

- [ ] Finish the existing AI Court app as a full XLN-money game.
  - Impact: product expansion after the core admin/runtime backlog is green.
  - Placement: do this after the core admin/runtime/evidence backlog, not before the current QA/health/runtime reliability work.
  - User-confirmed 2026-06-24: do this after everything else; the existing AI Court app must accept real XLN tokens, run a challenge, and pay the winner everything.
  - Requirement: use real XLN token/account flows, not mocks. A user can create a case, deposit/stake tokens, accept a challenge, submit evidence/arguments, resolve the challenge, and the winner receives the escrowed pot.
  - UI: case lobby, case detail, funding/deposit flow, challenge flow, evidence timeline, judgement/result screen, and payout history.
  - Runtime: escrow state is auditable through XLN accounts/batches; challenge settlement is deterministic; failed/expired cases refund by explicit rule.
  - Tests: two-user e2e funds both sides, opens a challenge, resolves it, verifies winner-takes-all balances, history, and no silent failure; unit tests cover payout/refund edge cases.
