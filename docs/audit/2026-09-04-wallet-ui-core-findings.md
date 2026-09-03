# Core findings from building the React wallet (ui/) — 2026-09-04

Scope: everything the new wallet hit in `core/` while porting the SvelteKit
payment/swap/activity path 1:1 and driving it with a browser-embedded runtime
(BrowserVM jurisdiction, three hosted entities, no relay). Each item has the
exact code path, how it showed up, what the wallet does today, and the decision
the core owner has to make. Nothing below was changed in `core/`; the wallet
carries workarounds where noted.

Severity: P1 = wrong data or a halted runtime from ordinary user input;
P2 = wrong presentation or a design gap the UI must paper over.

---

## 1. P1 — activity read leaks other hosted entities' account frames under the viewed entity

File: `core/api/public/activity-history.ts`, `buildRuntimeActivityEvents` →
`eventsFromAccountInput` (≈ line 428 and 596).

`eventFromEntityTx` filters with
`if (viewedEntityId && normalizeId(inputEntityId) !== viewedEntityId && !payloadMentionsEntity(tx, viewedEntityId)) return null;`
but the `accountInput` branch bypasses that function and calls
`eventsFromAccountInput` directly with no such check. Every account-frame
transaction of every entity the runtime hosts is then emitted with
`entityId: viewedEntityId || inputEntityId` — the viewed entity's id.

Observed: querying `activity` for Alice on a runtime that also hosts Hub One
and Meridian Desk returned "Credit limit updated with Meridian Desk", the hub's
`direct_payment` to the merchant ("Payment routed 5,000"), and the merchant's
`add_delta` lanes — all tagged `entityId = Alice`, all passing
`eventMatchesFilters`.

Wallet workaround: `ui/src/runtime/financial/movements.ts` keeps only
movements whose counterparty is one of the wallet's own bilateral accounts and
drops neutral-direction payments. This cannot separate Alice↔Hub frames from
Merchant↔Hub frames when both name the hub as counterparty.

Fix candidate: apply the same
`inputEntityId === viewedEntityId || payloadMentionsEntity(...)` gate before
`eventsFromAccountInput`, or pass `inputEntityId` through as `entityId`
instead of `viewedEntityId`.

## 2. P1 — direct-payment account tx reports the viewed entity as its own counterparty

File: `core/api/public/activity-history.ts`, `eventFromAccountFrameTx` case
`'direct_payment'` (≈ line 312) → `routeCounterparty(data['route'], viewedEntityId, targetEntityId || counterpartyId)` (≈ line 55).

The committed `direct_payment` account tx carries no `route`, so
`routeCounterparty` returns `recordedCounterparty` = `targetEntityId` = the
viewed entity when it is the payee. Result: "Payment received +10,000 with
Alice" shown to Alice. The queued `directPayment` runtime input (which has the
route) names the hub correctly, so the two entries for one payment disagree.

Wallet workaround: when folding, skip any counterparty equal to the viewed
entity and take the next candidate.

Fix candidate: when `route` is absent, derive the counterparty from the
account input's `fromEntityId`/`toEntityId` (already computed as
`counterpartyId` in `base`) instead of the target.

## 3. P2 — log-derived payment titles use the emitter's perspective

File: `core/api/public/activity-history.ts`, `eventFromLog` (≈ line 543).

`HtlcReceived` is emitted by the hop that received the lock. Viewed from the
sender (who is `fromEntity` in the payload), the event passes the
`payloadMentionsEntity` gate, gets `direction: 'out'`, but keeps the title
"Payment received" and `status: 'received'`. The sender therefore sees
"Payment received −25.00 USDC".

Wallet workaround: titles are derived from `direction` only ("Sent" /
"Received" / "Routed"); `title` from the read is ignored for payments.

Fix candidate: choose the title after `inferDirection`, not from the message
name; or expose `message` raw and let the reader label.

## 4. P2 — one payment is 5–7 activity entries with no single key

Same file. For one HTLC payment the sender's read returns: `htlc_lock`
account tx (hash present), `HtlcReceived` log from the hop (hash present),
`HtlcFinalized` log (hash present), and two `htlc_resolve` account txs with
**no** `hash` (data has `lockId`, the event does not map it). Direct payments
appear twice (queued runtime input + committed account tx) at different
heights with no shared key.

Wallet workaround: group by `hash`, merge direct payments within 6 frames,
drop hashless `htlc_resolve` entries (`ui/src/runtime/financial/movements.ts`).

Fix candidate: set `hash: data['lockId']` on `htlc_resolve` events; give
direct payments a stable id (e.g. `${height-of-input}:${tokenId}:${amount}`)
or emit only the committed entry.

## 5. P2 — the final recipient is not recoverable from committed events

Files: `core/entity/tx/handlers/account/committed-frame-followups.ts:21-47`,
`core/entity/tx/handlers/account/committed-htlc-followups.ts:336-355`,
`core/api/public/activity-history.ts` case `'htlcPayment': return null` (≈ line 447).

`HtlcFinalized` payload sets `toEntity: route.outboundEntity` = the next hop.
The paybook entry (`core/entity/types.ts:54`) stores no target. The runtime
input that does carry `targetEntityId` (`htlcPayment`) is deliberately dropped
by the activity read. `HtlcInitiated` carries `toEntity: prepared.targetEntityId`
and `route`, but it is a candidate effect at lock time and is not in
`PAYMENT_TERMINAL_EVENT_NAMES`.

Consequence: a receipt or activity row built purely from committed events can
say "Paid 25 USDC to Hub One" for a payment to Meridian Desk — the SvelteKit
spotlight avoids this by not naming anyone.

Wallet workaround: `usePaymentIntents` (localStorage) records what the user
addressed at submit time and binds it to the hashlock when `HtlcFinalized`
arrives (match on fromEntity + tokenId + amount ∈ {recipientAmount,
senderAmount} + description). Honest but local: a payment sent from another
device shows the hop.

Decision: keep the client-side binding, or (a) include `targetEntityId` in
`HtlcFinalized` (frame-log payload → parity with the Rust kernel), or (b) stop
dropping `htlcPayment` in the activity read (no consensus impact, read-side
only). (b) is the cheap one.

## 6. P1 — one rejected entity tx halts the whole runtime loop

Files: `core/entity/consensus/proposal/infra-context.ts:148`
(`ENTITY_INFRA_LIVENESS_OBSERVER_UNAVAILABLE`), hub config validation
(`HUB_REBALANCE_TOKENLESS_RAW_OVERRIDE_FORBIDDEN:rebalanceBaseFee,rebalanceGasFee`
from `setHubConfig` with zero fees), surfaced as
`RUNTIME_ENTITY_INPUT_APPLY_FAILED … → RUNTIME_LOOP_ERROR → RUNTIME_LOOP_HALTED`.

Both were ordinary inputs from the UI. Both took the runtime down (no further
frames, `[system] RUNTIME_LOOP_HALTED`), not just the offending tx. Fail-stop
is the repo rule for invariants, but an operator-supplied `setHubConfig` with a
rejected field, or an `htlcPayment` on a runtime without an observer, are
input errors. The user sees a dead wallet and has to reload.

Question for the owner: should `applyEntityInput` reject a tx (drop it,
surface the error to the submitter) and keep the loop alive, or is halting the
intended contract for every apply failure? If halting stays, the adapter needs
a documented "reject before apply" validation hook so shells can pre-check.

## 7. P2 — embedded runtime without p2p cannot pay: liveness observer is a p2p side effect

Files: `core/runtime/envelope/p2p-lifecycle.ts:197` installs
`env.infrastructure.observeOnlineEntityIds`; the scenario harness and the hub
orchestrator install their own; `xln.main()` alone installs none.

A browser that runs `xln.main(seed)` and hosts several entities locally can
open accounts and extend credit but the first HTLC throws (see 6). The wallet
now installs a "hosted replicas are online" observer right after `main()`
(`ui/src/runtime/adapter.ts`, `installHostedLivenessObserver`).

Decision: make `main()` install the hosted observer by default (p2p then
replaces it), or document that HTLC requires p2p and expose a supported
`installLocalLivenessObserver(env)` in the public API instead of a UI-side
shim.

## 8. P2 — spoke auto-rebalance prepays fees for requests the hub can never fill

Path: `checkAutoRebalance` → `request_collateral` → fee prepaid
(base + gas + liquidity bps) unless the policy is manual
(`r2cRequestSoftLimit === hardLimit`).

On a hub with zero reserve the spoke's automatic collateral request cannot be
filled, but the fee is still debited (≈1.1 USDC per request in the sandbox: a
10,000 opening balance arrived as 9,998.9). The wallet sets the manual policy
during sandbox bootstrap.

Question: should `request_collateral` be gated on the hub advertising a
reserve for the token (gossip profile), or should the fee be refundable when
the request lapses unfilled?

## 9. P2 — `clearDB` on a live runtime corrupts the head instead of refusing

`xln.clearDB(env)` while the loop is running produced
`STORAGE_APPEND_INVARIANT_FAILED: refusing to write frame 76 after persisted head 0`
and a halted loop. The wallet stops the loop first. A guard inside `clearDB`
(refuse when the loop is live, or stop it) would remove the trap.

## 10. Info — display rounding

Not core, but visible: `formatMoney` in the wallet truncated to 2 dp while USD
totals rounded, so 9,974.99995 showed as 9,974.99 next to a total of 11,475.00.
Fixed on the wallet side (half-up). The SvelteKit `formatTokenAmount`
behaviour was not checked; worth one look if both shells must agree.

---

## What the wallet asks core for, in priority order

1. Gate `eventsFromAccountInput` by viewed entity (item 1) and fix the direct-payment counterparty (item 2). Both are read-side only; no consensus change.
2. Decide the apply-failure contract (item 6). This is the one that turns a UI bug into a dead runtime.
3. Stop dropping `htlcPayment` in the activity read or add the target to `HtlcFinalized` (item 5).
4. Ship the hosted liveness observer from `main()` (item 7).
5. `hash` on `htlc_resolve` events and stable ids for direct payments (item 4).
6. Rebalance fee gating (item 8), `clearDB` guard (item 9).

Evidence: `ui/tests/e2e-payment.spec.ts` (green at HEAD), run logs in the
2026-09-03 session; screenshots `ui/tests/test-results/ui-*.png`.

## 11. P1 (in-flight, uncommitted) — frame-journal retention change makes committed receipts disappear

Observed 2026-09-04 ~01:50 against the live `bun run dev` bundle
(`frontend/static/runtime.js` built from the working tree, which carries
uncommitted changes in `core/storage/index.ts`, `core/storage/keys.ts`,
`core/storage/recovery/{load,restore}.ts`, `core/storage/recovery/journal/replay.ts`,
`core/runtime/types.ts` and the test
`core/__tests__/storage/history/storage-frame-journal-retention.test.ts`;
`DEFAULT_MATERIALIZE_PERIOD_FRAMES` 1 000 → 100, new
`persistenceLastMaterializedHeight`).

Symptom: the payment commits (balance −25, Activity shows "Sent"), but the
wallet's payment-terminal monitor never sees `HtlcFinalized` in
`readPersistedFrameJournals(env, {fromHeight, toHeight})`, so no receipt and
no recipient binding. No monitor error is raised. The same wallet code against
the bundle built from HEAD passes the E2E (`ui/tests/e2e-payment.spec.ts`,
12 s).

Reading: whatever changed in journal retention/materialization is dropping or
relocating the frame log entries the SvelteKit `View.svelte` and the React
wallet both rely on (`PAYMENT_TERMINAL_EVENT_NAMES` over `journal.logs`).
Please run `cd ui && bun run test:e2e` before landing that storage change; it
is the only test that exercises the browser-side receipt path.
