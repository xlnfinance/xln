# Cross-J Layer 1 → rscore rewrite: handoff prompt

Paste this to the next agent (Claude / Codex / GPT) as-is.

---

You continue the XLN cross-jurisdiction swap simplification. Work ONLY in the git
worktree `/Users/zigota/xln-layer1` (branch `crossj-layer1-progress`, top commit
latest commit on the branch; base `adde297ae`). Never edit or merge `main`. One stable commit per
step. Answer in Russian, tersely. Owner rules: delete more than you add; TS canon
first, then Rust parity; cancel is decided by the book owner/hub, the user only
requests; ask the owner before choosing LLM models for quorums (use the newest).

## State you inherit (all gates green on the branch head)
Layer 1 is DONE: fill progress is Hub-internal, one uint16 ratio per order.
- matcher → `CrossJurisdictionFillInstruction` (`core/extensions/cross-j/orderbook.ts`)
  → book owner applies it in the same Entity frame
  (`core/entity/tx/handlers/cross-j/book-order.ts: applyCrossJurisdictionBookFillToState`)
  → source hub applies the same ratio locally or via ONE non-authoritative sibling tx
  `crossJurisdictionFillNotice` (`core/entity/tx/handlers/account-cross-j-followups.ts:
  applySourceHubCrossJurisdictionFillProgress`) → terminal ⇒ `requestCrossJurisdictionClear`
  self-output → proposer materializes the paired `cross_pull_close` at the committed ratio.
- Account layer: `cross_pull_close` (`core/account/tx/handlers/settlement/pull.ts`) checks
  ladder-verified ratio == proof ratio, this leg == floor(|amount|·r/65535), binaryHash,
  hub authorship; deletes the source offer. Pull binding = `{orderId, routeHash, leg, status}`.
- Removed: `cross_swap_fill_ack`, `cross_pull_progress`, `applyCrossJurisdictionBookProgress`,
  `pendingCrossJurisdictionFillAcks`, settlementPolicy/priceImprovement, pendingFill/pendingCancel,
  dust terminality, cohort progress pairing. Route hash ABI shrank.
- Rust mirror: `rscore/crates/entity-kernel/src/cross_j/{mod.rs,committed.rs}`
  (`with_fill_progress`, `apply_source_hub_fill_progress`, `apply_book_fill_to_state`,
  `commit_cross_jurisdiction_book_fill`, `apply_cross_jurisdiction_cancel_request`),
  `orderbook/matcher.rs::apply_cross_jurisdiction_fill_deltas`, engine `apply_pull_close`.
- Invariants that MUST survive: ladder reveal is the only settlement authority; both legs
  claim floor(total·r/65535) for one r (enforced by the Runtime close cohort: unpaired or
  mismatching closes are rejected on the receiving runtime, `core/runtime/delivery/topology/
  entity-routing.ts crossCloseKey`); partial reveal stays disputable on-chain; atomic
  opening/close cohorts unchanged; TS and Rust produce identical outputs/state.
- Tests for the new path: `core/__tests__/cross-j/swap/cross-jurisdiction-fill-progress.test.ts`,
  `cross-jurisdiction-removal-ack-idempotence.test.ts`. Fixtures regenerated
  (`rscore/fixtures/{account-semantics,cross-j-entity-kinds,cross-j-opening}`, tx-wire vectors).
- Known pre-existing red (not yours): `DisputeStarted relays payment secrets` test,
  E2E payment `.receipt-card`, `security:failure-taxonomy` (missing `core/runtime/frame/clone.ts`).

## Gates (run before every commit)
```
bun run check:runtime-types && bun test core/__tests__/cross-j && bun test core/__tests__/rscore
bun core/scripts/checks/consensus/check-canonical-fill-scan.ts && bun run check:nested-hash-coverage && bun run check:unused-surface
cd rscore && cargo clippy --workspace --all-targets --all-features -- -D warnings && cargo fmt --all -- --check
CARGO_TARGET_DIR=/Users/zigota/xln/rscore/target bun tools/run-rscore-tests.ts
XLN_RSCORE_REQUIRE_BINARY=1 bun core/scripts/checks/rscore/check-rscore-parity.ts
XLN_RUNTIME_SEED=$(openssl rand -hex 32) bun core/scripts/e2e/runners/run-with-test-cleanup.ts --reason=mm-mesh -- bun core/scenarios/run.ts mm-mesh
```
Use `CARGO_TARGET_DIR=/Users/zigota/xln/rscore/target` for cargo (dependency cache);
the parity gate builds its own release binary inside the worktree. Never run the
stand scenarios in parallel with other heavy runs (mm-mesh false-fails on contention).

## Your task: "ideal cross-J in rscore" — minimum code, same invariants
1. Read `docs/consensus-invariants.md` (cross-J section) and the memory note
   `cross-j-atomic-cohort-simplification-2026-09-04.md` (design analysis + quorum: keep
   Design A, source-first close, no target-first close — theft found by Kimi K3).
2. In Rust, collapse the cross-J entity surface to ONE module with the minimal state
   machine: route mirror `{orderId, routeHash, legs, pulls, fillSeq, ratio, status,
   clearingPolicy, closeProofs}`; admission `{status, route}`; transitions
   admit → fill(ratio) → clear_requested → clearing → settled|cancelled|expired, plus
   dispute/salvage. Delete every second path that decides the same thing (the TS side
   listed two: removal-ACK vs terminal-fill both requesting clear; keep the fence).
   Keep the Rust orderbook's SameJOffer/resolving model only if deleting it costs more
   than it saves.
3. Every deletion must keep `rscore:parity` exact against the TS fixtures; when TS has
   dead code that Rust exposes, delete it in TS first (TS canon), regenerate fixtures,
   then Rust.
4. Report per step: net LOC, list of deleted surfaces, gate results. No praise.

Open items the last quorum flagged and I did NOT change (decide with the owner):
- TS halts the runtime on an invalid sibling `crossJurisdictionFillNotice`
  (`CROSS_J_FILL_NOTICE_STALE_CONFLICT` / `CROSS_J_FILL_PROGRESS_INVALID`) while Rust
  rejects the frame; both fail loud, but the taxonomy differs.
- Rust `committed_pull_close` requires proof amounts == committed mirror amounts
  (`ECONOMICS_MISMATCH`); TS only forbids a ratio rollback. Same-ratio inputs agree
  (mirror amounts are floor(total·r/65535)); pick one rule for both.
- A cross-J `cross_pull_close` for an unknown pullId returns "already closed" (TS and
  Rust alike) — decide whether to reject.
- Sub-lot remainders rest until expiry sweep or cancel (dust terminality deleted on purpose).
- Self-emitted `requestCrossJurisdictionClear` outputs use `config.validators[0]` as signer
  while `assertSelfRuntimeContinuations` expects `route.sourceHubSignerId`; equal for
  single-signer hubs (the only supported topology today), would halt a multi-validator hub.
  Use `crossJurisdictionRouteSignerHint(route, entityId)` when multisig hubs return.
- TS `handleCrossPullClose` reports `swap_cancelled` (source offer retired) while Rust
  emits `SwapOfferRemove`; parity fixtures accept both — collapse to one outcome.
- The target hub's route mirror learns progress only from the carried `crossPullClose`
  route (no notice reaches the target hub when the source hub owns the book); fine for
  settlement, blind for UI/salvage until close — decide whether the target hub needs the notice.
---
