# Task: guard scan for shared-field in-place mutation

**Owner:** GLM agent
**Branch:** `fix/radapter-oversized-read-storm`
**Priority:** high — two shipped perf levers rest on an unenforced invariant
**Type:** static check + regression test, no runtime behavior change

## 1. Context

Two merged perf levers share references instead of deep-cloning, on the
invariant **"handlers replace, never mutate in place"**:

- **Lever S** (`963a1dc0a`, `forkAccountDraftShell`): Account draft overlays
  share `mempool`, `currentFrame`, `pendingFrame`, `pendingAccountInput`,
  `lastOutboundFrameAck`, `disputePrepare`, `activeDispute`,
  `boardResealMigration`, `counterpartyBoardReseal` by reference with the
  committed replica.
- **Lever T** (`ee7b3f78e`, section digest cache): per-section state-root
  digests are cached on `EntityState` keyed by **source field object
  identity** (`===`). Any in-place mutation of a section field leaves the
  reference unchanged → stale digest → **silently wrong state root**.

Today the invariant is verified by manual grep only. One future in-place
mutation inside an overlay/draft context = silent committed-state corruption
with no error raised.

Existing guard: `core/scripts/checks/consensus/state/check-no-readonly-account-mutation.ts`
(AST scan, runs in `check:src`). Its watched field list covers Account
*collections* (`deltas`, `locks`, `swapOffers`, …) but **not** the newly
shared envelope fields or EntityState sections.

## 2. Scope

### 2a. Extend (or sibling) the AST scan

Flag mutating calls on these fields **when the receiver may be a
draft/overlay/shared reference**:

- Account envelope: `mempool`, `currentFrame`, `pendingFrame`,
  `pendingAccountInput`, `lastOutboundFrameAck`, `disputePrepare`,
  `activeDispute`, `boardResealMigration`, `counterpartyBoardReseal`
- EntityState sections: every field in `ENTITY_STATE_ROOT_FIELDS`
  (see `core/entity/consensus/state-root.ts`)

Mutating methods to catch (existing set in the check): `push`, `splice`,
`pop`, `shift`, `unshift`, `sort`, `set`, `delete`, `clear`, `fill`,
`copyWithin`, `reverse`, plus property-assignment writes
(`account.currentFrame.x = …`) — the current scan only covers method calls,
not assignment through a shared reference.

Known-legitimate sites to whitelist explicitly (audited 2026-08-23):

- `core/account/input/mempool.ts:53` — admission on the live replica
- `core/account/consensus/incoming/ack-commit.ts:215` and
  `consensus/index.ts:553` — post-commit auto-rebalance (committed replica)
- `open-account.ts:151` / `inbound-account.ts:206` — writes into freshly
  constructed account objects

### 2b. Regression test: draft-discard isolation

Add a test proving: begin draft → push into a shared field via the draft →
discard the overlay → base replica's field is provably untouched
(length/identity unchanged). Mirror for `currentFrame` field assignment.

### 2c. Wire into gates

The extended scan must run in `check:src` alongside the existing check.
Follow the repo's check-script conventions (fail-fast, loud, named codes).

## 3. Acceptance criteria

1. Scan flags a synthetic in-place mutation on any §2a field (prove with a
   temp fixture, then remove it).
2. Zero false positives on the current tree (whitelist §2a sites with
   per-site justification comments).
3. Draft-discard regression test passes.
4. `bun run check:src` green; full `bun run check` green before merge.

## 4. Notes

- Repo rules: pure functions, no new deps, scans live under
  `core/scripts/checks/`, tests under `core/__tests__/`.
- Do not change runtime behavior. If the scan finds a *real* live mutation
  in an overlay context, stop and report — that is a consensus bug, not a
  lint fix.
- Reference docs: `docs/hlt-throughput-report-2026-08-22.md`,
  `docs/hlt-dead-zone-probe-2026-08-23.md`,
  `docs/hlt-apply-phase-optimization-2026-08-24.md` (§4 safety analysis).
