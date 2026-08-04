# React wallet Plan 009 swap and activity inventory

This inventory records the canonical source and state ownership for the React swap, order, and activity surfaces. React validates boundaries and presents evidence; it does not reproduce Runtime routing, capacity, price requantization, fee, or account formulas.

## Quote and route contract

| UI evidence | Canonical source | Stale boundary | Failure behavior |
|---|---|---|---|
| Liquid asset choices | `XLNModule.isLiquidSwapToken` over the committed token catalog | Entity frame or catalog change | Missing pair is an explicit unavailable state |
| Same-j route | Committed source account plus directory Hub identity, signer, and jurisdiction | Route value, Entity frame, source account height | Missing Hub/signature/jurisdiction disables or removes the route |
| Cross-j route | Same-Runtime target Entity plus source/target Hub identities, signers, and jurisdiction refs | Route value, Entity frame, source and optional target account heights | Missing signer evidence disables the route; absent target account is encoded distinctly |
| Decimal amount | `XLNModule.parseTokenAmount` | Exact input text and token ID | Invalid/non-positive input fails loud |
| Price ticks | Exact positive integer supplied by the user or canonical relay orderbook | Exact tick text and token pair | No local price estimate or float conversion |
| Quote amounts/capacity/dust | `XLNModule.planSwapCommand().preparedOrder` and `sourceOutCapacity` | Immutable draft plus committed evidence identity | Planner rejection is displayed verbatim |
| Fees | Execution-bound canonical evidence | Offer lifecycle evidence | UI never invents a preflight fee |

`createSwapDraftIdentity` binds the visible frame, route, pair, amount text, and exact price ticks. `createSwapRequestIdentity` additionally binds source and target account heights, normalized Entity/Hub IDs, raw amount, and route evidence. The request coordinator accepts only the latest asynchronous result; confirmation rechecks the visible draft before submission.

## Durable actions

| User action | Canonical operation | Idempotency/completion evidence |
|---|---|---|
| Submit same-j order | Planner-provided `RuntimeInput` | One evidence identity is guarded by `runWalletIntentOnce`; Runtime command receipt remains pending/accepted/observed until committed evidence exists |
| Submit cross-j order | Planner target setup, then planner-provided cross-j intent | One request identity and deterministic offer ID; target absence is explicit rather than an empty fabricated account |
| Cancel same-j order | Canonical account `swapCancel` Entity transaction | Runtime receipt and refreshed committed account history |
| Clear cross-j order | Canonical `cross_jurisdiction_swap_clear` Entity transaction with explicit cancel remainder | Runtime receipt and refreshed committed account history |

Repeat clicks and React Strict Mode cannot create a second durable intent for the same request identity. An input/frame change closes review and invalidates prior evidence.

## Order lifecycle mapping

| Canonical evidence | UI state |
|---|---|
| Open offer, no cancel request | `open` |
| Open offer, cancel requested | `cancel-requested` |
| Closed resolve at full ratio or exact executed give at/above original give | `filled` |
| Closed resolve with a nonzero partial fill | `partial` |
| Closed cancel evidence without fill | `canceled` |
| Closed without fill/cancel evidence | `closed` |

Open offers, lifecycle entries, closed resolves, execution amounts, fee token consistency, heights, and price ticks are validated before projection. Unknown or malformed persisted evidence throws; it is never mapped to zero, pending, or success.

## Live and historical ownership

- The wallet account external store retains the latest immutable Entity/account projection only.
- Swap orders issue point reads at the selected committed Entity height and release component-local results on navigation.
- Activity uses the disk-backed `runtimeQueryClient.readActivity` interface. Pagination cursors, filters, stable timestamp/height/ID ordering, boundary deduplication, and conflicting duplicates are validated by a pure adapter.
- `walletActivityController.release()` invalidates in-flight reads and drops page results when the Activity view unmounts.

## Verification evidence

- React TypeScript: `frontend/node_modules/.bin/tsc -p frontend/tsconfig.react.json --noEmit` — pass.
- L1: 13/13 tests pass across swap view projection, request identity/races, and activity history adapter.
- React wallet build: 1,545 modules; main JS 1,553.50 kB, 467.53 kB gzip.
- Strict focused browser flow: pass in 11.5 seconds, with clean console/network health and six inspected wide/laptop/iPhone screenshots.
- Preserved browser evidence: `.logs/e2e-parallel/20260804-102135-736`.
- Real market-maker lifecycle and `test:e2e:flows`: blocked before Vite/Playwright (`vite=0`, `pw=0`) by `HUB_BASELINE_STALLED hubs=H1,H2,H3`; Hubs could not reach the relay. Preserved broad-flow failure evidence: `.logs/e2e-parallel/20260804-101833-931`.
- Repository gate: `bun run check` passed, including unchanged frozen core, static determinism/safety gates, TypeScript, Svelte compatibility, and all three React surface builds.

The live spec still covers quote loading, multiple routes, confirmation, insufficient-capacity rejection, duplicate-click submission, committed receipt, order detail, activity filtering/detail, three viewport classes, a committed state dump, and strict browser health. No mock or fallback path was introduced to bypass the baseline failure.

## Decomposition and render scope

- Form/confirmation/submission ownership: `WalletSwapWorkspace` (182 lines).
- Async quote evidence and race ownership: `use-wallet-swap-quote` (177 lines).
- Relay subscription ownership: `use-wallet-orderbook` (125 lines).
- Pure route, quote, and order projections are separate modules, each below 200 lines.
- Route candidate construction is memoized because it is a directory/account combination; quote, order, and activity rows remain direct projections. The final focused browser benchmark was faster than the prior comparable run, so no speculative row memoization was added.
