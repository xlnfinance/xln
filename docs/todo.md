# todo

Last updated: 2026-06-23

Scope: synthesized from four external admin/QA/runtime audits. This is the operator-grade backlog for `/health`, `/qa`, runtime adapter import, test history, scenario playback, restart controls, and regulator evidence.

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
  - Status: done. Runtime import stdout logs count/access/path/expiry/labels/wallet only; hub inspect URLs are logged without query/hash secrets.
  - Evidence: unit asserts no `runtime-import=`, `xlnra1.`, token strings, or base64 manifest in log lines. Focused browser e2e imported mesh/custody/MM runtimes and the new run logs had no `runtime-import=` or `xlnra1.` outside the local secret manifest.

- [x] Fix reserve faucet missing-event invariant.
  - Impact: high.
  - Current issue: faucet could return `500 RESERVE_EVENT_MISSING` after `getReserves()` confirmed the money moved.
  - Product decision: this should not be downgraded to best-effort. The event should arrive in runtime before application; if reserve grew without a recent event, that is an invariant bug.
  - Root cause: watcher-fed canonical J-events were enqueued/applied through `processEventBatch` without being recorded in recent evidence, and the global 1,000-event ring could be displaced by unrelated jurisdiction traffic.
  - Status: done. Submitted J-events and watcher-ingress J-events now share one evidence recorder; `ReserveUpdated` is also indexed by `entityId:tokenId`, so unrelated traffic cannot hide the matching reserve event.
  - Evidence: L1 failed before fix, then passed: two-jurisdiction watcher reserve evidence survives 1,100 unrelated reserve events and still rejects `expectedMin` above the matching event.

## p1 trust and correctness

- [ ] Replace fake video transcript sync with real in-browser cue timestamps.
  - Impact: high.
  - Current issue: scenario cues are synthesized from phase durations and linearly mapped to video duration. Setup phases that are not in the Playwright video can appear as subtitles over wallet footage.
  - Fix: record cue timestamps from browser/test markers relative to video start. Store `cues.json` and generate WebVTT. Keep infra setup phases in a separate setup strip, not in video subtitles.
  - Tests: browser E2E asserts a cue text matches the actual video step window; WebVTT loads; cue click seeks to expected video time.

- [x] Capture browser console errors, page errors, failed requests, and HTTP 4xx/5xx per shard.
  - Impact: high.
  - Status: done. Playwright specs import the shared QA fixture, which records unexpected console warnings/errors, `pageerror`, failed non-benign requests, and HTTP 4xx/5xx into shard JSONL. The isolated runner folds this into manifest `browserIssues` and `browserHealth`, history SQLite counters, run rows, verdict, failure inbox, and shard Browser Health panel.
  - Policy: benign local analytics warnings and navigation/static `net::ERR_ABORTED` cancellations are filtered; page errors, HTTP 5xx, and real failed fetch/xhr/network issues remain blocking.
  - Evidence: unit covers browser issue normalization/history counts; focused QA cockpit e2e fixture shows FAIL from browser health and a clean real focused run records browserHealth 0/0/0/0.

- [ ] Add unified severity model.
  - Impact: high.
  - Statuses: `OK`, `WARN`, `DEGRADED`, `FAIL`, `BLOCKED`, `UNKNOWN`.
  - Required fields: `severity`, `reason`, `since`, `owner`, `evidence`.
  - Apply to health, QA runs, bootstrap stages, restart state, remote adapter, and benchmarks.
  - Tests: API schema rejects missing `severity`/`reason` for release runs.

- [ ] Add failure class per shard/run.
  - Impact: high.
  - Classes: `assertion`, `infra`, `timeout`, `flake`, `crash`, `security`, `unknown`.
  - Fix: derive from phase failure, fatal markers, Playwright result, console/page errors, and history at same code hash.
  - UI: filter by failure class; default-select first blocking failure.
  - Tests: infra boot failure is not rendered as assertion regression.

- [ ] Fix numeric signer key cache isolation by runtime seed.
  - Impact: high.
  - Current issue: numeric signer private keys are cached by `signerId` only. Two test/runtime envs in one Bun process with different `runtimeSeed` and signer `2` can reuse the wrong private key and trigger `LAZY_HANKO_SELF_MISMATCH`.
  - Constraint: consensus/crypto path; require explicit design approval before changing. Candidate fix is cache numeric derivations by `(seed fingerprint, signerId)` while keeping registered EOA keys keyed by address.
  - Tests: two envs with different seeds and same numeric signer process frames in one Bun process without cache cross-contamination.

- [ ] Scope watcher start-block clamp to the watcher's own jurisdiction/depository.
  - Impact: high.
  - Current issue: minimum finalized J height is taken across all entity replicas, so an unrelated entity/jurisdiction can drag a watcher backward and cause re-scan storms.
  - Fix: compute min height only for entities whose depository/jurisdiction matches the watcher.
  - Tests: two-jurisdiction env with low unrelated entity does not lower watcher cursor.

- [x] Consolidate the duplicated reserve faucet implementation.
  - Impact: high.
  - Current issue: `runtime/server/reserve-faucet.ts` is the canonical handler, but `runtime/orchestrator/hub-node.ts` still had a stale inline `/api/faucet/reserve` copy with old wait helpers.
  - Status: done. hub-node now calls `handleReserveFaucet()` with its local bootstrap hub and token catalog deps; the inline route body and local wait/reserve helpers were deleted.
  - Evidence: runtime typecheck and `bun run check` cover the shared handler wiring.

- [ ] Decide BrowserVM adapter fate: delete dead stack or restore a real adapter.
  - Impact: high.
  - Current issue: `mode: 'browservm'` can be selected as a fallback while `createBrowserVMAdapter()` always throws.
  - Fix: either remove BrowserVM mode branches and dead provider stack, or implement a real adapter with startup tests.
  - Tests: no startup fallback can reach a throw-only adapter; if retained, BrowserVM smoke test deploys and watches events.

- [ ] Fix external-wallet snapshot baseline to use confirmed block, not tip.
  - Impact: medium.
  - Current issue: snapshot block can be reorged out on non-anvil RPC. This is display state, not consensus state, but still wrong evidence.
  - Fix: snapshot at `currentBlock - confirmationDepth`, include `sourceHeight`, `sourceHash`, and `finalityDepth`.
  - Tests: snapshot uses safe block; UI shows source height/hash.

- [ ] Move display-only `externalWallet` state out of consensus hot-path entity state.
  - Impact: medium-high.
  - Current issue: external wallet state is cloned/validated/persisted with EntityState even though it is excluded from the frame hash.
  - Fix: move it to `env.runtimeState` or a dedicated side store keyed by entityId, with explicit source height/hash/finality metadata.
  - Tests: entity frame hash remains unchanged by wallet display deltas; wallet panel still renders from side-store snapshots.

- [ ] Fix runId/timezone model.
  - Impact: medium.
  - Current issue: runId is local-time based while legacy parsing assumes UTC. UI uses locale string without timezone.
  - Fix: generate run IDs in UTC or stop deriving timestamps from run IDs when manifest has epoch. Render `YYYY-MM-DD HH:mm:ss UTC`, with local time only as hover/secondary.
  - Tests: runId timestamp round trip is deterministic across timezones.

## p1 product and UX

- [ ] Add single system verdict banner.
  - Impact: high.
  - UI: sticky top banner with `SYSTEM PASS/DEGRADED/FAIL`, failing surface count, last run UTC, git HEAD, code hash, dirty flag, regression status, browser error count.
  - Drill-down: clicking a reason filters runs/shards to exact evidence.
  - Partial shipped: `/qa` now has a sticky `PASS/DEGRADED/FAIL/UNKNOWN` banner with reason count, git HEAD, code hash, dirty flag, latest run time, benchmark regression, and browser health failures.
  - Remaining: backend schema-backed severity.
  - Tests: failed fixture shows FAIL banner and selects failing shard.

- [ ] Build canonical run ledger.
  - Impact: high.
  - UI/API fields: status, severity, suite, category, gitHead, codeHash, dirty, startedBy, duration, failedShard, artifactBytes, cpuP95, ramPeak, browserErrors, networkFailures, audit action.
  - API: `/api/qa/runs` reads SQLite history as canonical source; manifest JSON is ingest/backfill only.
  - Tests: fixture with three HEADs renders sortable ledger and regression deltas.

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

- [ ] Add regression comparator.
  - Impact: high.
  - Compare current run vs previous same code hash, previous same HEAD, and last green on main.
  - Metrics: wall time, phase time, peak load, child CPU, runner RSS, artifact bytes, new failing handles.
  - UI: `REGRESSION` badge with percent deltas and threshold reason.
  - Tests: `+25% totalMs`, `+30% RSS`, or new failing handle produces WARN/FAIL.

- [ ] Add phase-time waterfall per shard.
  - Impact: medium.
  - UI: stacked bar for preflight, anvil, API boot, health, Vite, Playwright. Flag phase above p95 historical.
  - Tests: phase fixture renders stable labels and flags budget breach.

- [ ] Add failure inbox.
  - Impact: high.
  - Inputs: fatal runtime markers, browser/page errors, network failures, phase budget breaches, restart failures.
  - UI: one page/list of latest failure causes linking directly to shard, log tail, video time, artifact.
  - Partial shipped: initial inbox covers failed runs, browser/page/network/HTTP health, benchmark regressions, and failed restart audit rows.
  - Remaining: fatal log line linking, phase budget breaches, and video-time deep links.
  - Tests: fatal marker fixture maps to exact shard and log line.

- [x] Add e2e UX screenshot gallery for design audits.
  - Impact: high.
  - Status: done. Curated e2e screenshots now write PNG plus JSON metadata under `ux-gallery/{desktop,mobile}` inside Playwright artifacts; `/api/qa/stories` reads metadata and the QA cockpit shows a top preview plus full `UX Gallery` tab.
  - Coverage: screenshot smoke generated 26 curated PNGs and 26 metadata sidecars across onboarding, assets, accounts, payment, receive, swap menus, move, and settings. Move/swap/dispute flows are annotated for on-chain batch, resting order, active dispute, finalized dispute, and history screenshots when those e2e paths run.
  - Evidence: focused QA cockpit e2e verifies preview/full gallery rendering; focused screenshot e2e generated 26 curated screenshots.

- [ ] Make `/health` read only its dedicated health surface.
  - Impact: medium.
  - Goal: avoid mixing all admin dashboards into health. Health should embed or link QA cockpit, not become the full QA implementation.
  - UI: `/health` shows verdict, bootstrap/infra health, lightweight QA teaser, and cockpit link/embed.

- [ ] Separate privileged operations from read-only QA views.
  - Impact: high.
  - UI: read-only by default. Put restart/run controls in an `Operations` or `Admin` tab, hidden until admin scope is active.
  - Tests: read mode cannot see or trigger run controls; admin mode requires confirm.

- [ ] Implement `/qa?embed=1` properly or remove it.
  - Impact: medium.
  - Current issue: health embed passes `embed=1`, but route does not honor it.
  - Fix: embed mode hides sidebar/heavy nested iframe controls and shows compact cockpit teaser, or remove the param.
  - Tests: embedded cockpit has no nested iframe-in-iframe layout.

- [ ] Split `EntityPanelTabs.svelte` into tab-owned components.
  - Impact: medium-high.
  - Current issue: the file is over 8k lines and keeps absorbing unrelated feature diffs.
  - Fix: move Accounts, Reserves, Swaps, J-events, External Wallet, and remote/runtime sections into `Entity/tabs/*.svelte` with a thin parent and shared typed stores.
  - Tests: smoke each tab with existing fixtures; no behavior change in active entity selection.

## p2 performance and scale

- [ ] Make `listQaHistory` pure SELECT on the hot path.
  - Impact: high.
  - Current issue: history endpoint re-reads and upserts manifests from disk on every poll.
  - Fix: record history once at run completion. Add explicit one-shot backfill endpoint/command for legacy runs.
  - Tests: `/api/qa/history` does not read manifest files in hot path.

- [x] Add manual retention cleanup for old QA runs.
  - Impact: medium.
  - Product decision: store all runs by default. Add a manual admin action to delete run logs/history older than 30 days when explicitly requested.
  - Status: done. `/api/qa/retention` requires admin POST and exact confirm `DELETE_OLDER_THAN_30_DAYS`; History tab exposes the disabled-by-default control and result count.
  - Evidence: unit deletes only a controlled fake run older than cutoff; focused QA cockpit e2e verifies disabled state, exact confirm, POST, and result rendering.

- [ ] Strip `perf.samples` from default `/api/qa/run` payload.
  - Impact: high.
  - Current issue: per-second samples are shipped and mostly discarded by UI.
  - Fix: summary in run payload; raw timeseries via `/api/qa/run/perf?runId=...` only when chart opens.
  - Tests: run payload excludes `perf.samples`; perf endpoint returns samples.

- [ ] Add ETag or shared polling store for QA/health data.
  - Impact: medium.
  - Current issue: multiple panels poll overlapping endpoints every 15 seconds.
  - Fix: single shared store or SSE/WS updates; use ETag/304 for unchanged history/runs.
  - Tests: two panels mounted produce one network request per interval.

- [ ] Keep 1M-account remote snapshots aggregate-first.
  - Impact: high.
  - Requirement: server returns small snapshots; frontend drill-down is cursor/page based.
  - API: counts, hashes, sample IDs, top deltas, pagination cursors, not full arrays.
  - Tests: 1M fake hub snapshot stays under 100KB and renders under 100ms without main-thread freeze.

- [ ] Virtualize large run/shard/artifact lists.
  - Impact: medium.
  - Tests: 200+ shard run remains responsive; no layout shift on hover/status changes.

## p2 data quality and simplification

- [ ] Replace heuristic scenario metadata with authored metadata.
  - Impact: medium.
  - Current issue: handles/descriptions/summaries are partly inferred with regex and word truncation.
  - Fix: `targets.json` or scenario manifest contains `handle`, `title`, `summary10w`, `description`, `steps[]`, `owner`, `severityPolicy`.
  - Tests: known golden scenarios preserve handle/summary exactly.

- [ ] Remove duplicated media blocks; Scenario Player owns video/screenshots.
  - Impact: medium.
  - UI: QA detail page has one player and one right-side evidence panel.

- [ ] Merge overlapping Runs/Suites/Benchmarks surfaces.
  - Impact: medium.
  - UI: one Runs ledger with category chips: unit, contract, e2e, benchmark, scenario. Benchmarks tab should chart bench metrics, not duplicate history rows.

- [ ] Collapse raw log tail by default and show structured summary first.
  - Impact: medium.
  - UI: raw logs behind explicit expand/open artifact. Summary shows severity, failure class, fatal marker, browser/network errors.

- [ ] Stop using future/test run IDs that pollute history.
  - Impact: medium.
  - Tests: Playwright should route fixtures or use temp DB/log root, never persistent future `.logs` entries.

- [ ] Fix remote orderbook compact depth.
  - Impact: low-medium.
  - Current issue: compact view recomputes `totalQtyLots` from selected first 20 orders only.
  - Fix: preserve source level total while still truncating visible order IDs.
  - Tests: level with 25 orders shows full depth and only 20 visible orders.

- [ ] Decide strict `0x` RPC result behavior for external wallet snapshots.
  - Impact: low.
  - Current issue: strict bigint parse fails on empty `0x`.
  - Decision: for token calls, invalid result should identify bad token and degrade that token, not 500 the whole dashboard, unless release gate requires fail-fast.
  - Tests: non-contract token returns structured token error.

- [ ] Align stale `RequiredBrowserVM.approveErc20` type.
  - Impact: low.
  - Current issue: helper type says `Promise<string>` while core adapter returns `Promise<JEvent[]>`.
  - Fix: update scenario helper type and decide whether callers apply returned deltas or intentionally discard them.
  - Tests: TypeScript catches incompatible adapter.

## security backlog

- [ ] Add token redaction to log tail/artifact rendering.
  - Redact bearer tokens, `xlnra1.`, private keys, mnemonics, auth seeds, RPC URLs with credentials, and token-bearing import URLs.

- [ ] Add artifact sensitivity classification.
  - Artifacts: public, internal, secret-bearing. Secret-bearing artifacts require admin scope or are unavailable in regulator export.

- [ ] Hide absolute server paths from operator UI.
  - Return relative artifact/log IDs, not raw filesystem paths.

- [ ] Add restart cooldown and watchdog.
  - Single-flight 409 exists, but rapid sequential restart and hung child need cooldown plus `SIGKILL` after timeout + grace.

- [ ] Split `restartStatus()` into pure getter and explicit reaper.
  - Current getter mutates `activeRestart`; make state transitions explicit and testable.

- [ ] Confirm destructive/admin actions.
  - Typed confirm for restart-run, db reset, deleting history, switching admin token, disconnecting during active restart.

## missing tests

- [ ] Unit: manifest ingest preserves timeline order and derives slow steps sorted.
- [ ] Unit: severity classifier and failure-class classifier.
- [ ] Unit: regression threshold math against same code hash and previous HEAD.
- [ ] Unit: UTC formatter and runId timezone round-trip.
- [ ] Unit: `sanitizeE2ETarget` invalid target, self-target, null byte, traversal.
- [ ] Unit: `resolveQaArtifactPath` traversal and symlink escape rejection.
- [ ] Unit: `listQaHistory` hot path is SQLite-only after backfill.
- [ ] Unit: run payload strips `perf.samples`.
- [x] API: QA read token can list runs/artifacts but cannot restart.
- [x] API: admin restart requires operator id, reason, expected HEAD, and confirm.
- [ ] API: restart disabled returns 403; concurrent restart returns 409; invalid mode returns 400.
- [x] API: artifact endpoints are same-origin and token-gated.
- [x] API: audit row written for restart start and updated on finish.
- [ ] E2E: `/qa?runId=...` deep-link selects exact run and video shard.
- [ ] E2E: failed run opens directly to failed shard and first failure cue.
- [ ] E2E: missing video shows stable empty state with no console errors.
- [ ] E2E: scenario transcript cue scrubs video to real marker timestamp.
- [ ] E2E: verdict banner shows FAIL on failed fixture and PASS on green fixture.
- [ ] E2E: history compare renders deltas and regression badge.
- [ ] E2E: restart run disabled in read mode and enabled only in admin mode.
- [ ] E2E: 1M account health snapshot renders aggregate view without freezing.
- [ ] Failure fixtures: browser console error, pageerror, network 502, fatal log marker, phase budget exceeded, corrupt manifest, empty logs dir.
- [ ] Golden regulator scenarios: baseline mesh reserves, payment smoke, multi-hop HTLC, dispute lifecycle return, reserve faucet, rebalance, market-maker order placement.

## ideal 1-month UX

- [ ] `/health` opens to one verdict: `READY`, `DEGRADED`, or `FAIL`, with exact blocking reason, data age, source height, code hash, and owner.
- [ ] Bootstrap timeline shows preflight, hub mesh, same-chain, cross-chain, market maker, custody, health poll, ready hash, budget vs actual, backlog, and last event.
- [ ] `/qa` feels like a regulator-grade video evidence system: run playlist left, video center, real transcript right, failed cue highlighted, artifacts below.
- [ ] `/runs` is a ledger across unit, contract, e2e, scenario, benchmark, and release gates.
- [ ] `/ops` is gated and audited: release gate, bootstrap soundcheck, MM soak, shard rerun, restart.
- [ ] Every chart compares current vs same-codeHash baseline, previous HEAD, and last green.
- [ ] Remote runtime state is always aggregate/cursor/hash based; no full 1M arrays in browser.
- [ ] Regulator export produces one evidence bundle: health snapshot, run ledger, videos, WebVTT, hashes, audit trail, failure explanations, and redacted artifacts.

## recommended build order

1. Secure the QA surface: auth, CORS, restart audit, env allowlist, token redaction.
2. Make evidence honest: real WebVTT cue timestamps, browser/network error capture, failure class.
3. Make the ledger canonical: SQLite-first runs/history, no hot-path manifest re-ingest, regression comparator.
4. Make it regulator-readable: verdict banner, failure inbox, phase waterfall, UTC timestamps.
5. Make it scale-safe: strip perf samples by default, aggregate 1M snapshots, virtualized lists.
6. Clean up UX debt: embed mode, metadata source of truth, remove duplicate views, collapse raw logs.
