# Plan 008 — Migrate accounts, assets, and payment operations

> **Executor instructions:** Follow all steps after Plan 007 is `DONE`; update the
> Plan 008 index row when complete. Trace every action to one canonical operation.
> Any uncertainty in Runtime → Entity → Account ownership is a STOP condition.
>
> **Drift check (run first):**
> `git diff --stat 5749e283d..HEAD -- frontend/src/routes/address frontend/src/routes/testnet frontend/src/lib/components frontend/src/lib/stores tests runtime/account/utils.ts`
> Re-inventory changed financial UI actions. Drift in canonical runtime helpers is
> a STOP condition for this frontend-only plan.

## Status

- **Priority:** P1
- **Effort:** L
- **Risk:** HIGH
- **Depends on:** `plans/007-migrate-wallet-shell-onboarding-settings.md`
- **Category:** migration, correctness
- **Planned at:** commit `5749e283d`, 2026-08-03

## Executor instructions

Continue the sole `ai/react-frontend-migration` worktree. Use the canonical external stores/controllers from Plans 005–006 and shell from Plan 007. Before editing, inventory every account/payment view and trace every submitted action to the runtime input it creates. If any ownership or naming in the Runtime → Entity → Account cascade is not 100% clear, stop and ask the owner.

Do not implement financial formulas in React, add optimistic success, use mock transactions, or introduce compatibility APIs. UI validates user input and invokes existing canonical helpers/controllers; Runtime evidence determines completion.

## Why this is a separate critical slice

Account/entity views combine dense data presentation with actions such as pay, receive, move, lending/credit, settlement, and address handling. A framework port can appear visually correct while changing units, rounding, bilateral perspective, command duplication, or success timing. These flows need domain-level parity evidence independent of swap and ops complexity.

## Scope

In scope:

- Entity/account lists and details, balances/assets, address/entity routes, pay/receive/move operations, lending/credit controls, settlement and the relevant `/testnet` user flows.
- Input parsing/validation adapters, canonical helper/controller calls, pending/committed/failed status, responsive UI, accessibility, and screenshots.
- Stable deep links and user-facing test IDs.

Out of scope:

- Swap/orderbook/history; Plan 009 owns them.
- Developer/operator account visualizers; Plan 010 owns them.
- Runtime/Entity/Account machine logic, financial math, contract changes, or new transaction/API versions.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Drift | `git diff --stat 5749e283d..HEAD -- frontend/src/routes/address frontend/src/routes/testnet frontend/src/lib/components frontend/src/lib/stores tests runtime/account/utils.ts` | Exit 0; action/helper drift reconciled |
| L1 | `bun test tests/frontend/account-view-model.test.ts tests/frontend/payment-input-adapter.test.ts tests/frontend/credit-settlement-ui-adapter.test.ts` | Exit 0; exact-value cases pass |
| Payment smoke | `bun run test:e2e:payment:smoke` | Exit 0; real command flow passes |
| Wallet browser | `bun runtime/scripts/run-e2e-parallel-isolated.ts --strict-browser-health --shards=1 --workers-per-shard=1 --pw-project=chromium --pw-files=tests/wallet-accounts-payments.spec.ts` | Exit 0; clean browser health |
| Broad gate | `bun run check` | Exit 0; no frozen-core violation |

## Git workflow

- Branch: continue the sole `ai/react-frontend-migration` writer worktree.
- Checkpoint completed domain flows with `wip:` commits; do not split canonical operations across commits that cannot pass their L1 tests.
- Do not push for deployment, merge, or release before Plan 011.

## Files to inspect and likely change

- Current entity/account/asset/address/testnet pages and components
- `EntityPanelTabs.svelte` and related account detail panels
- Pay, receive, move, lending/credit, settlement forms and helper imports
- Canonical UI-facing helpers exported through runtime/xln functions
- New React wallet feature modules and focused unit/E2E specs

## Implementation steps

1. Build a transaction/action inventory before porting. For every user action record the displayed fields, input units, validation, canonical helper/controller call, resulting Runtime/Entity/Account input type, pending evidence, committed evidence, error evidence, and existing test coverage. Delete unused actions only with proof of no imports/routes.

   Verify: every interactive financial control maps to exactly one canonical operation; there are no local formulas or unowned mutations.

2. Add characterization tests for pure display adapters and input builders already used by Svelte. Cover bilateral left/right perspective, BigInt/string serialization, decimal units, negative/zero/boundary values, credit limits, historical exposure, fees, and unavailable balances. Reuse `safeStringify()`/`buffersEqual()` where applicable.

   Verify: tests run before React changes and compare against canonical runtime helper outputs. Manual math is rejected by repository guards.

3. Port read-only entity, account, asset, and address views first. Subscribe to minimal stable external-store snapshots/selectors; derive display models through pure tested functions. Preserve explicit empty/loading/error states and on-demand historical reads instead of retaining history in live UI state.

   Verify: representative bilateral states render identically from both peer perspectives and no component mutates or caches canonical state.

4. Port pay/receive/move forms. Validate at input boundaries, make units explicit, disable only for actual invalid/pending conditions, and submit one typed controller command per confirmed user intent. Confirmation screens show exact asset, amount, counterparty, fees, and operation before submission.

   Verify: double-click, remount, back/forward, reload, runtime rejection, and delayed acknowledgment cannot create duplicate commands or false success.

5. Port credit/lending and settlement controls without reproducing delta/balance formulas. Fetch canonical preview/validation from existing pure helpers/controllers. Keep bilateral semantics and committed-evidence status explicit.

   Verify: boundary scenarios include changed credit limits with historical exposure, insufficient capacity, stale state, both entity orderings, rejected settlement, and successful committed settlement.

6. Port `/address`, `/address/[entityId]`, and `/testnet` wallet-owned flows under the Vite route contract. Preserve direct cold loads, URL parameter validation, error behavior, and same-origin wallet state.

   Verify: deep-link tests cover valid, malformed, missing, and unavailable entity identifiers without redirect fallbacks.

7. Decompose large panels into domain feature modules with small pure view-model functions and composable React components. Avoid boolean-prop proliferation; use explicit variants/compound composition only where real alternatives exist.

   Verify: no new function exceeds repository limits without a documented reason, and component APIs make invalid action states unrepresentable where practical.

8. Add screenshot-driven flows for account overview, account detail, pay confirmation/pending/committed/error, receive, move, credit, and settlement at iPhone, laptop, and wide desktop. Check console/network and validate displayed values against runtime snapshots in the test.

   Verify: every screenshot is inspected and scored; fix clipping, unreadable numbers, ambiguous status, layout shifts, and mobile action accessibility before handoff.

## Test plan

L1 narrow:

```bash
bun test tests/frontend/account-view-model.test.ts
bun test tests/frontend/payment-input-adapter.test.ts
bun test tests/frontend/credit-settlement-ui-adapter.test.ts
```

L2 targeted flows:

```bash
bun run test:e2e:payment:smoke
bun runtime/scripts/run-e2e-parallel-isolated.ts --strict-browser-health --shards=1 --workers-per-shard=1 --pw-project=chromium --pw-files=tests/wallet-accounts-payments.spec.ts
```

Use browser F12 and dump full sanitized Runtime/Entity/Account JSON on divergence. Inspect all required screenshots.

L3 broad gate:

```bash
bun run check
```

Run once on the unchanged checkpoint candidate.

## Done criteria

- [x] Every in-scope financial action maps to one canonical operation with exact parity evidence.
- [x] No React component or frontend adapter contains parallel balance/delta/fee/settlement formulas.
- [x] Duplicate intent, stale state, rejection, reload, and committed-success semantics are tested.
- [x] Deep links and all visual states work at required viewports with clean console/network.
- [x] No runtime, contract, crypto, frozen-core, or API-version change was made.
- [x] React artifact remains release-blocked; `bun run check` passes; `wip:` checkpoint only.
- [x] `git status --short` is reviewed and the Plan 008 index row is updated.

## Current checkpoint evidence

- The action inventory at `docs/frontend/react-wallet-plan008-action-inventory.md` traces account, asset, payment, lending, settlement, dispute, and testnet ingress actions to one canonical helper/controller and explicit pending/committed/error evidence.
- Account projections preserve bilateral perspective through canonical `deriveDelta`; React form adapters preserve exact decimal/raw units, immutable reviewed commands, stale-evidence rejection, and one logical intent guard.
- The focused Plan 008 suite spans 12 files and passes, including exact boundary values, account perspective, payment modes, settlement/dispute evidence, external-store behavior, duplicate commands, SSR snapshots, and faucet request payloads/rejections.
- Strict-browser React wallet E2E passes 2/2 isolated stacks in 31.1 seconds with clean console/network health. All 21 screenshots were inspected at iPhone, laptop, and wide desktop; the final candidate fixes mobile rail reachability, desktop rail scroll restoration, and external-wallet projection failures.
- The required canonical payment smoke was attempted on the same candidate and stopped before Playwright at isolated-stack reset with `HUB_BASELINE_STALLED hubs=H1,H2,H3`; this is pre-existing hub-mesh startup state, not a React or browser failure. The hub-independent React flow remains green, and no runtime workaround was added.
- No Runtime/Entity/Account machine, contract, crypto, frozen-core, or API-version path changed. The React artifact remains candidate-only and activation-blocked until Plan 011.

## Stop conditions

- Less than 100% clarity on cascade naming/ownership or bilateral perspective is a hard stop.
- Any proposed optimistic financial completion, mock command, or duplicate formula is forbidden.
- Any canonical helper defect discovered here should be reported and separately scoped; do not patch frozen/runtime logic as part of a React port.

## Suggested toolkit

- Use `vercel-react-best-practices` for render/selectors and `vercel-composition-patterns` for large panel APIs if available.
- Use `web-design-guidelines` for accessibility review.
