# Task: guard scan for shared-field in-place mutation

**Owner:** GLM agent
**Branch:** `fix/radapter-oversized-read-storm`
**Status:** ✅ Lever S complete (commit `28fcc8c77`). Lever T deferred.
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
_collections_ (`deltas`, `locks`, `swapOffers`, …) but **not** the newly
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

## 4. Implementation — Lever S (complete)

**Commit:** `28fcc8c77` — `guard: AST scan for draft envelope field in-place mutation (lever S)`

### 4a. Root cause of the gap

The existing scan only tainted variables from `state.accounts.get()` calls.
Handler functions receive `AccountDraftReplica` as a **parameter** — never
tainted. So `draft.mempool.push(tx)` in a handler was invisible to the scan.

### 4b. Scan extension

Added to `check-no-readonly-account-mutation.ts`:

- **Draft-parameter taint**: parameters whose type annotation includes
  `DraftReplica` are marked draft-tainted. Text-level heuristic on the type
  reference name — `AccountDraftReplica` is the only `*Replica` type with
  `Draft` in its name, so false positives are unlikely.
- **Envelope field set**: `accountEnvelopeFields` — the 9 shared fields.
- **`isEnvelopeUnsafeReceiver`**: detects envelope field access through
  draft-tainted variables, including:
  - Direct access: `account.mempool`
  - Aliases: `const mp = account.mempool`
  - Destructuring: `const { mempool } = account`
  - Nested chains: `account.mempool[0].status`
- **Mutation detection**: method calls, property assignments (`=`, `+=`, …),
  `delete`, `++`/`--`, `Object.assign`/`Reflect.set` on envelope-unsafe
  receivers.
- **Correctly distinguishes** in-place mutation (`account.mempool.push()` —
  flagged) from field reassignment (`account.mempool = []` — not flagged,
  only affects draft shell).
- **Correctly excludes** collection mutations (`account.state.deltas.put()` —
  not flagged, overlay-protected) and read-only access.

### 4c. Self-tests

6 positive (catches mutations):

- `envelope-method-call.ts`: `account.mempool.push({})`
- `envelope-property-assign.ts`: `account.currentFrame.height = 5`
- `envelope-alias-method.ts`: `const mp = account.mempool; mp.push({})`
- `envelope-destructure-method.ts`: `const { mempool } = account; mempool.push({})`
- `envelope-delete-element.ts`: `delete account.mempool[0]`
- `envelope-object-assign.ts`: `Object.assign(account.currentFrame, { height: 5 })`

3 negative (proves safe patterns not flagged):

- `envelope-reassign-safe.ts`: `account.mempool = []; account.pendingFrame = undefined`
- `envelope-collection-safe.ts`: `account.state.deltas.put(1, …); account.state.locks.set(…)`
- `envelope-read-safe.ts`: `const len = account.mempool.length; const frame = account.currentFrame`

### 4d. Regression test

`core/__tests__/account/state/draft/envelope-isolation.test.ts` — 4 tests:

1. Draft shares `mempool` and `currentFrame` by reference with the base
2. Discard preserves base `mempool` identity and length
3. Publish does not overwrite live envelope fields (collection mutations only)
4. Base `mempool` content is provably untouched after draft discard

### 4e. Whitelist — not needed

The 4 audited sites all operate on `AccountReplica` (not `AccountDraftReplica`):

- `mempool.ts`: `AccountMempoolSubject = Pick<AccountReplica, 'mempool'>`
- `ack-commit.ts` / `consensus/index.ts`: `account: AccountReplica`
- `open-account.ts` / `inbound-account.ts`: freshly constructed objects

The draft-specific taint does not fire on `AccountReplica` parameters, so no
whitelist mechanism was required.

### 4f. Verification

- `NO_READONLY_ACCOUNT_MUTATION_OK` — zero false positives
- `bun run check:src` — all 35 gates green
- `bun test core/__tests__/account/state/draft/envelope-isolation.test.ts` — 4/4 pass

## 5. Lever T — deferred

EntityState section guard (35 `ENTITY_STATE_ROOT_FIELDS`) is deferred to a
separate pass. The scan architecture needs a **depth-aware assignment check**
to distinguish field replacement (`state.height = 5` — safe, cache invalidates)
from in-place mutation (`state.config.threshold = 3` — unsafe, reference
unchanged → stale digest). The false-positive surface in Entity consensus
internals (which legitimately replace scalar fields during frame application)
requires careful scoping to handler directories only.

## 6. Notes

- Repo rules: pure functions, no new deps, scans live under
  `core/scripts/checks/`, tests under `core/__tests__/`.
- Do not change runtime behavior. If the scan finds a _real_ live mutation
  in an overlay context, stop and report — that is a consensus bug, not a
  lint fix.
- Reference docs: `docs/hlt-throughput-report-2026-08-22.md`,
  `docs/hlt-dead-zone-probe-2026-08-23.md`,
  `docs/hlt-apply-phase-optimization-2026-08-24.md` (§4 safety analysis).
