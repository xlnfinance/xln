# Plan 009 — Migrate swap, routing, history, and activity

> **Executor instructions:** Follow all steps after Plan 008 is `DONE`; update the
> Plan 009 index row when complete. Use full sanitized Runtime/Entity/Account dumps
> for divergence. Never default malformed data to zero, pending, or success.
>
> **Drift check (run first):**
> `git diff --stat 5749e283d..HEAD -- frontend/src/lib/components frontend/src/lib/stores frontend/src/lib/runtime-command tests runtime`
> Rebuild the swap/order/history source inventory for changed files. A change to
> canonical routing/order semantics is a STOP condition for this UI plan.

## Status

- **Execution:** DONE — L1/build/focused browser green; real market-maker L2 is infrastructure-blocked before Playwright by `HUB_BASELINE_STALLED`
- **Priority:** P1
- **Effort:** L
- **Risk:** HIGH
- **Depends on:** `plans/008-migrate-wallet-accounts-payments.md`
- **Category:** migration, correctness
- **Planned at:** commit `5749e283d`, 2026-08-03

## Executor instructions

Continue the single `ai/react-frontend-migration` worktree. Trace every swap/order/routing interaction through existing canonical helpers and runtime commands before porting it. Use complete sanitized Runtime/Entity/Account dumps to investigate divergence. Do not edit consensus/state-machine code, invent quotes, or substitute zero/default values after malformed data.

## Why this is isolated

`SwapPanel.svelte` is about 2,919 LOC and combines dense quote/order state, asynchronous routing, forms, status, and history. History/activity also crosses persisted live state and on-demand historical reads. This deserves its own parity gate rather than being folded into generic wallet conversion.

## Scope

In scope:

- Swap form, quote/route selection, orderbook and order lifecycle displays, confirmation/submission/status, activity/history views, filtering/details, and associated wallet navigation.
- Canonical data adapters/controllers, stale quote protection, reload/error states, responsive UI, accessibility, and screenshots.

Out of scope:

- Changes to routing, quote, fee, orderbook, HTLC, settlement, or account consensus formulas.
- Operator scenario/history tools; Plan 010 owns them.
- New swap features or API versions.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Drift | `git diff --stat 5749e283d..HEAD -- frontend/src/lib/components frontend/src/lib/stores frontend/src/lib/runtime-command tests runtime` | Exit 0; semantics drift reviewed |
| L1 | `bun test tests/frontend/swap-view-model.test.ts tests/frontend/swap-request-identity.test.ts tests/frontend/activity-history-adapter.test.ts` | Exit 0; exact/stale/race cases pass |
| Swap browser | `bun runtime/scripts/run-e2e-parallel-isolated.ts --strict-browser-health --shards=1 --workers-per-shard=1 --pw-project=chromium --pw-files=tests/wallet-swap-history.spec.ts` | Exit 0; clean browser health |
| Targeted flows | `bun run test:e2e:flows` | Exit 0 after L1/L2 are green |
| Broad gate | `bun run check` | Exit 0; no frozen-core violation |

## Git workflow

- Branch: continue the sole `ai/react-frontend-migration` writer worktree.
- Checkpoint complete, green state slices with `wip:` commits.
- Do not push for deployment, merge, or release before Plan 011.

## Files to inspect and likely change

- `SwapPanel.svelte` and all imported swap/orderbook/route components
- Activity/history components and disk-history query clients
- Existing swap/routing/payment helpers exposed to the frontend
- New React wallet swap/history modules
- Swap, payment-flow, and history unit/E2E specs

## Implementation steps

1. Build a feature/state inventory for swap and history. Record asset/amount inputs, quote request identity, route candidates, fee/limit display, expiration/staleness, confirmation, command construction, pending/committed/failed evidence, order lifecycle, and historical query pagination/detail behavior.

   Verify: every displayed amount/status and every submitted action names its canonical source; no local calculation is unaccounted for.

2. Characterize current pure adapters and controller behavior with fixed deterministic inputs. Cover no route, one/multiple routes, stale quote, changed balances, fee boundaries, partial/in-flight order states if supported, rejection, reload, and completed history.

   Verify: exact BigInt/string values and route/order identifiers are asserted; malformed canonical data fails loudly.

3. Extract any remaining view-only transformation into small pure functions without reproducing financial formulas. Query live snapshots from external stores and historical frames from their dedicated disk-backed query interfaces on demand.

   Verify: live store snapshots retain only current/in-flight state, while history pagination/detail reads are requested and released explicitly.

4. Port the swap input and quote/route UI. Tie each result to an immutable request identity and underlying state/evidence. Invalidate stale results explicitly when inputs or canonical state change. Never auto-select or submit a route whose evidence no longer matches confirmation.

   Verify: racing responses, rapid input changes, navigation, reload, and state updates cannot display/submit a stale route.

5. Port confirmation and submission through the Plan 006 command controller. Show exact source/destination asset, input/output, fees, route/counterparties as currently supported, and expiration/evidence. One confirmation creates one durable user intent.

   Verify: repeat click, Strict Mode, delayed journal write, runtime rejection, and reload produce no duplicate order/payment and no premature success.

6. Port orderbook/order lifecycle and activity/history. Status labels must be a pure mapping from canonical states. Preserve filtering, pagination, detail links, empty/error/loading states, and deterministic ordering.

   Verify: a test fixture with equal timestamps/sequence edge cases has stable ordering, and unknown states fail loudly rather than mapping to “pending.”

7. Decompose `SwapPanel` by state ownership: form, quote result, route choice, confirmation, active operation, and historical details. Use explicit component variants rather than many booleans. Memoization is allowed only after measuring a render bottleneck and proving semantic safety.

   Verify: React profiling on the largest realistic order/history fixture records interaction latency and unnecessary render counts before/after targeted optimization.

8. Add screenshot-driven E2E for empty swap, quote loading, multi-route result, confirmation, stale/rejected route, pending, committed, failed, history list, and history detail at all three viewport classes.

   Verify: compare displayed amounts/status to the full sanitized runtime dump and inspect every screenshot plus F12 console/network.

## Test plan

L1 narrow:

```bash
bun test tests/frontend/swap-view-model.test.ts
bun test tests/frontend/swap-request-identity.test.ts
bun test tests/frontend/activity-history-adapter.test.ts
```

L2 targeted flow:

```bash
bun run test:e2e:flows
bun runtime/scripts/run-e2e-parallel-isolated.ts --strict-browser-health --shards=1 --workers-per-shard=1 --pw-project=chromium --pw-files=tests/wallet-swap-history.spec.ts
```

If `test:e2e:flows` is broader than the exact swap failure being investigated, first isolate the smallest matching scenario/spec and only run the broad flow once L1/L2 are green.

L3 broad gate:

```bash
bun run check
```

Run once on the unchanged checkpoint candidate.

## Done criteria

- [x] Swap, routing, order lifecycle, activity, and history are complete React flows over canonical helpers/controllers.
- [x] Stale/racing quote evidence and duplicate submission are explicitly prevented and tested.
- [x] Live versus historical state ownership follows repository rules.
- [x] No parallel route/fee/order/account formula exists in UI code.
- [x] Focused visual/console evidence covers wide, laptop, and iPhone; the real market-maker states remain blocked before Playwright by the documented baseline failure.
- [x] Artifact remains release-blocked; `bun run check` passes; `wip:` checkpoint only.
- [x] `git status --short` is reviewed and the Plan 009 index row is updated.

## Stop conditions

- Unclear fee, route, order, HTLC, or committed-state semantics require owner clarification.
- Never default malformed output to zero, pending, or an empty successful result.
- A canonical runtime defect is a separate protocol task; do not conceal it in React adapters.

## Suggested toolkit

- Use `vercel-react-best-practices` and `vercel-composition-patterns` if available.
- Use the repository ASCII + JSON runtime debugging workflow for any divergence.
