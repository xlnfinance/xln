// Spec self-test: the Account frames page checks clean, and each planted bug is caught
// by the property it breaks. Run from spec/: node test.mjs
import { evaluate, lib } from "./tools/run.mjs";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";

// A page is its file plus the dict `check` walks; a planted bug is a file loaded after the
// page that redefines one of its functions.
const pages = {
  account: { files: ["account/frames.scm"], spec: "account-frames" },
  money: { files: ["money/core.scm", "money/ledger.scm"], spec: "ledger" },
  dispute: { files: ["money/core.scm", "dispute/dispute.scm"], spec: "dispute" },
  entity: { files: ["entity/consensus.scm"], spec: "entity-consensus" },
  clock: { files: ["account/clock.scm"], spec: "account-clock" },
  frame: { files: ["entity/frame.scm"], spec: "entity-frame" },
  runtime: { files: ["runtime/tick.scm"], spec: "runtime" },
  j: { files: ["j/batch.scm"], spec: "j-batch" },
  routing: { files: ["entity/routing.scm"], spec: "routing" },
};
const check = (page, extra) => evaluate([...lib, ...pages[page].files, ...extra], `(check ${pages[page].spec})`);

const planted = (page, name, file, violated, config) => ({
  page,
  name: `planted: ${name}`,
  extra: [...(config ? [config] : []), `${pages[page].files.at(-1).split("/")[0]}/bugs/${file}.scm`],
  expect: (r) => assert.equal(r.violated, violated),
});

const cases = [
  { page: "account", name: "account frames", extra: [], expect: (r) => assert.deepEqual(r, { ok: true, states: 3651, transitions: 11335, goals: 16 }) },
  { page: "account", name: "account frames, the link may also reorder (Quint's network, R-NET)", extra: ["account/configs/reorder.scm"], expect: (r) => assert.deepEqual(r, { ok: true, states: 7312, transitions: 33183, goals: 16 }) },
  { page: "account", name: "account frames, Right's txs conflict with each other", extra: ["account/configs/same-side-conflict.scm"], expect: (r) => assert.deepEqual(r, { ok: true, states: 3423, transitions: 10383, goals: 24 }) },
  planted("account", "the validator ignores the txs ahead in the same frame (a6, Byzantine frame)", "frame-order", "no committed tx is invalid against the history before it", "account/configs/same-side-conflict.scm"),
  planted("account", "drop on rollback", "drop-on-rollback", "no submitted tx is lost: committed, held, or refused"),
  planted("account", "rollback after mempool", "rollback-after-mempool", "each side's txs commit in submission order"),
  planted("account", "no tie-break", "no-tie-break", "committed histories agree: one extends the other"),
  planted("account", "no re-ack of a duplicate", "no-reack", "can always still finish"),
  planted("account", "a duplicate is re-acked only while Open (Quint's rule, R-REACK)", "reack-open-only", "can always still finish"),
  planted("account", "commit a frame that skips ahead", "commit-any-frame", "no tx is both committed and refused"),
  planted("account", "skip re-validation", "skip-revalidation", "can always still finish"),
  { page: "clock", name: "account clock (R-CLOCK, R-HTLC-CLOCK)", extra: [], expect: (r) => assert.deepEqual(r, { ok: true, states: 2730, transitions: 10546, goals: 260 }) },
  { page: "clock", name: "account clock, the payee holds no secret", extra: ["account/configs/no-secret.scm"], expect: (r) => assert.deepEqual(r, { ok: true, states: 173, transitions: 473, goals: 3 }) },
  planted("clock", "a stale stamp is refused, the signed frame is stuck (R-CLOCK)", "refuse-late", "no frame is refused for its age or its future date: a signed frame has an exit (R-CLOCK)"),
  planted("clock", "a stamp ahead of the receiver's clock is refused (R-CLOCK)", "refuse-future", "no frame is refused for its age or its future date: a signed frame has an exit (R-CLOCK)"),
  planted("clock", "expiry decided from the proposer's stamp (R-CLOCK)", "expire-by-frame-stamp", "an expiry commits only when both parties' views are strictly past the deadline (R-HTLC-CLOCK b)"),
  planted("clock", "an expiry at deadline + reserve, not past it (R-HTLC-CLOCK b)", "expire-at-deadline", "an expiry commits only when both parties' views are strictly past the deadline (R-HTLC-CLOCK b)"),
  planted("clock", "an expiry without the reserve (R-HTLC-CLOCK b, R-DRIFT)", "expire-no-reserve", "an expiry commits only when both parties' views are strictly past the deadline (R-HTLC-CLOCK b)"),
  planted("clock", "a payee holding the secret does not reveal it before the chain passes the deadline (R-HTLC-CLOCK c)", "payee-idle", "a payee that holds the secret has revealed it on-chain before an expiry commits (R-HTLC-CLOCK c)"),
  planted("clock", "a resolve refused by its frame stamp inside the deadline (R-CLOCK, #57)", "resolve-late-by-stamp", "a resolve is refused only when the payer's own view is past the deadline: never by the frame stamp, never by the chain height (R-HTLC-CLOCK a)"),
  planted("clock", "a resolve refused by the chain height, not the payer's own view (R-HTLC-CLOCK a)", "resolve-by-chain-height", "a resolve is refused only when the payer's own view is past the deadline: never by the frame stamp, never by the chain height (R-HTLC-CLOCK a)"),
  { page: "money", name: "money ledger", extra: [], expect: (r) => assert.deepEqual(r, { ok: true, states: 1440, transitions: 12918, goals: 0 }) },
  planted("money", "a second lock on an open hashlock is accepted (R-ONE-LOCK-PER-HASH)", "duplicate-hashlock", "at most one open clause per hashlock (R-ONE-LOCK-PER-HASH)"),
  planted("money", "a collateral withdrawal is co-signed without the credit check after it (R-SETTLE-CREDIT, Q-X-3)", "settle-ignores-credit", "credit holds: RCPAN in the worst case over the open clauses"),
  planted("money", "ignore open clauses in the guard", "ignore-clauses", "credit holds: RCPAN in the worst case over the open clauses"),
  planted("money", "credit lowered below usage", "credit-below-usage", "credit holds: RCPAN in the worst case over the open clauses"),
  planted("money", "a payment moves the allocation the wrong way", "pay-wrong-way", "pay n: the payer's allocation falls by n; nothing else moves"),
  planted("money", "a resolved clause lands on the wrong side", "resolve-wrong-side", "resolve: the clause pays, Δ moves against its payer by its amount"),
  planted("money", "a lapsed clause pays out", "expire-pays", "expire: the clause lapses, Δ and the money stay"),
  planted("money", "a Left deposit does not raise ondelta", "deposit-no-ondelta", "r2c / c2r: one unit between the payer's reserve and the collateral; a Left deposit is Left's allocation"),
  { page: "dispute", name: "dispute", extra: [], expect: (r) => assert.deepEqual(r, { ok: true, states: 5397, transitions: 9946, goals: 2486 }) },
  planted("dispute", "finalize a stale start before T", "early-finalize", "the responder is never worse off than the newest proof it held"),
  planted("dispute", "no floor on the response windows", "no-floor", "the responder is never worse off than the newest proof it held"),
  planted("dispute", "Right outranks Left at an equal nonce", "tie-break-inverted", "two proofs of one nonce and epoch have opposite proposers, and Left's outranks Right's (A12)"),
  planted("dispute", "no H1 wait for an HTLC deadline", "no-h1", "an HTLC is never settled as unpaid before its deadline"),
  planted("dispute", "Left paid past the collateral", "payout-no-cap", "a dispute pays out what the selected state says: net left + Δ, net right + collateral - Δ"),
  planted("dispute", "proof of an old epoch still pays", "no-epoch", "only a proof of the current epoch pays out"),
  planted("dispute", "the receiver signs a body it did not recompute", "blind-sign", "both sides sign the same proof: proofs of one nonce, proposer and kind have one body"),
  planted("dispute", "nobody checks RCPAN before signing a frame", "no-rcpan", "a frame that overdraws its proposer is never held: the receiver's own RCPAN check stands alone"),
  planted("dispute", "an ack lands after the response window (Q-D-3)", "late-ack", "a dispute pays what both sides had committed: the final proof ranks at least the newest frame proposed by T"),
  planted("dispute", "a response window at or below LAG (R-C11)", "window-below-lag", "the responder is never worse off than the newest proof it held"),
  planted("dispute", "a shortfall taken past the reserve", "shortfall-uncapped", "no reserve, collateral or debt is ever negative"),
  planted("dispute", "a secret at the deadline second does not pay", "secret-strict", "a clause pays exactly when its secret was public by the deadline"),
  planted("dispute", "a secret after the deadline pays", "secret-any-time", "a clause pays exactly when its secret was public by the deadline"),
  planted("dispute", "final Δ forgets ondelta", "delta-drops-ondelta", "Δ = ondelta + offdelta, less the clause if it paid"),
  planted("dispute", "a paid HTLC moves Δ the wrong way", "htlc-sign-flipped", "Δ = ondelta + offdelta, less the clause if it paid"),
  planted("dispute", "a timeout finalize does not consume a nonce", "chain-nonce-stale", "a timeout finalize consumes exactly one nonce; an adopted proof sets it"),
  { page: "dispute", name: "dispute, deadline beyond MAX_LOCK_HORIZON (N2)", extra: ["dispute/configs/far-deadline.scm"], expect: (r) => assert.deepEqual(r, { ok: true, states: 617, transitions: 879, goals: 403 }) },
  planted("dispute", "a lock beyond MAX_LOCK_HORIZON is signed (N2)", "no-horizon", "no lock is signed beyond MAX_LOCK_HORIZON: every held clause is within the horizon of the clock (N2)", "dispute/configs/far-deadline.scm"),
  planted("dispute", "the receiver skips its own RCPAN check (Byzantine proposer)", "receiver-skips-rcpan", "a frame that overdraws its proposer is never held: the receiver's own RCPAN check stands alone"),
  planted("dispute", "the proposer skips its own RCPAN check", "proposer-skips-rcpan", "an honest proposer never signs a frame that overdraws itself (its own RCPAN check)"),
  planted("dispute", "a dispute op leaves the payee's secret out of the calldata (#37, R3)", "omits-secret", "a payee that acted before the deadline knowing the secret is never left with the clause unpaid (#37)"),
  planted("dispute", "a settlement offered with an open clause (v1)", "settle-with-clause", "a cooperative settlement carries no open clause (v1)"),
  planted("dispute", "a settlement does not fold offdelta into ondelta", "settle-drops-off", "a cooperative settlement moves nothing: \u0394 and the money are the same before and after"),
  planted("dispute", "a Right-authored signed frame at stored + 1 only ties the implicit proof and loses to it (review B, finding 3)", "post-nonce-low", "in the new epoch a dispute pays the newest committed frame, never the implicit proof that ties it"),
  planted("dispute", "the implicit proof carries the stored nonce, not stored + 1", "implicit-nonce-stale", "after an epoch advance each side still holds a valid proof of the new epoch"),
  planted("dispute", "a deposit advances the epoch (review B, finding 2)", "deposit-advances-epoch", "a deposit does not advance the epoch: the epoch, the chain nonce and every held proof stay"),
  planted("dispute", "an implicit dispute settles at the ondelta of the advance and ignores a deposit of the epoch (review B, finding 2)", "implicit-stale-ondelta", "a dispute from the implicit proof settles at the chain's ondelta now: the advance's plus a deposit of the epoch"),
  { page: "dispute", name: "dispute, a window policy that lengthens inside the epoch (N3, E9)", extra: ["dispute/configs/window-policy.scm"], expect: (r) => assert.deepEqual(r, { ok: true, states: 12577, transitions: 23004, goals: 5868 }) },
  planted("dispute", "a counter shortens the windows of the epoch (N3, E9)", "counter-shortens-window", "windows never shorten inside an epoch: a later proof carries at least the windows of an earlier one, and a counter or final body at least the started ones", "dispute/configs/window-policy.scm"),
  planted("dispute", "the shared payment arithmetic moves Δ the wrong way (money/core.scm)", "core-pay-flipped", "a frame moves Δ as the ledger does: a payment moves the payer's allocation, a lock or a lapse leaves Δ"),
  planted("dispute", "the shared credit bound has no lower side (money/core.scm)", "core-rcpan-no-floor", "a frame that overdraws its proposer is never held: the receiver's own RCPAN check stands alone"),
  planted("dispute", "a responder with an unacked frame closes on a stale proof (B2)", "hasty-stale", "a hasty close still pays at least the newest frame both sides acked", "dispute/configs/no-rival.scm"),
  { page: "dispute", name: "dispute, no cross-open (B2)", extra: ["dispute/configs/no-rival.scm"], expect: (r) => assert.deepEqual(r, { ok: true, states: 2568, transitions: 4525, goals: 1243 }) },
  { page: "dispute", name: "dispute, Left's board rotates (H3)", extra: ["dispute/configs/retired-left.scm"], expect: (r) => assert.deepEqual(r, { ok: true, states: 8340, transitions: 15806, goals: 3731 }) },
  { page: "dispute", name: "dispute, Right's board rotates (H3)", extra: ["dispute/configs/retired-right.scm"], expect: (r) => assert.deepEqual(r, { ok: true, states: 8340, transitions: 15806, goals: 3731 }) },
  planted("dispute", "retired-board evidence settles in full (contracts before H3)", "h3-no-clamp", "retired-board evidence never draws on the retired side's reserve: retired Left settles at \u0394 >= 0, retired Right at \u0394 <= collateral (H3)", "dispute/configs/retired-left.scm"),
  planted("dispute", "the first, symmetric H3 clamp erases what a rotating entity is owed", "h3-symmetric", "what the retired side is owed is paid as signed, whoever starts (H3)", "dispute/configs/retired-right.scm"),
  { page: "dispute", name: "dispute, Right holds a reserve of 1 (H4)", extra: ["dispute/configs/right-reserve.scm"], expect: (r) => assert.deepEqual(r, { ok: true, states: 8905, transitions: 16926, goals: 4074 }) },
  { page: "dispute", name: "dispute, two disputes in a row, the second from the implicit proof (Q-D-21, decision D2)", extra: ["dispute/configs/two-disputes.scm"], expect: (r) => assert.deepEqual(r, { ok: true, states: 5432, transitions: 7179, goals: 5333 }) },
  { page: "entity", name: "entity consensus", extra: [], expect: (r) => assert.deepEqual(r, { ok: true, states: 9330, transitions: 37603, goals: 3072 }) },
  planted("entity", "own proposal kept on a conflicting certified frame (og today)", "commit-conflict", "can always still finish"),
  planted("entity", "own proposal dropped, its txs forgotten", "drop-txs-on-conflict", "no submitted tx is lost"),
  planted("entity", "a validator signs two frames at one height", "double-sign", "agreement: no two validators commit different frames at a height"),
  planted("entity", "installing a frame does not move the view (Q-E-6)", "no-view-sync", "can always still finish"),
  planted("entity", "a proposal for a future height is dropped (Q-E-7)", "drop-future", "can always still finish"),
  planted("entity", "installing a frame keeps its txs in the mempool", "install-keeps-mempool", "no tx is committed twice"),
  planted("entity", "a forwarded tx already committed is queued again", "fwd-no-dedup", "no tx is committed twice"),
  planted("entity", "a conflict keeps the signature on the old proposal", "conflict-keeps-signed", "a signature is for the height being decided: it is dropped when that height is committed"),
  { page: "entity", name: "entity consensus, quorum 3 of 3: the locked phase, liveness FINDING Q-E-8", extra: ["entity/configs/quorum-3.scm"], expect: (r) => assert.equal(r.violated, "can always still finish") },
  { page: "entity", name: "entity consensus, quorum 3 of 3, safety only", extra: ["entity/configs/quorum-3.scm", "entity/configs/quorum-3-safety.scm"], expect: (r) => assert.deepEqual(r, { ok: true, states: 3052, transitions: 14208, goals: 0 }) },
  { page: "entity", name: "planted: a frame commits one signature short of the quorum", extra: ["entity/configs/quorum-3.scm", "entity/configs/quorum-3-safety.scm", "entity/bugs/early-commit.scm"], expect: (r) => assert.equal(r.violated, "a frame is committed only with quorum distinct validators having signed it") },
  { page: "frame", name: "entity frame", extra: [], expect: (r) => assert.deepEqual(r, { ok: true, states: 1770, transitions: 2228, goals: 1158 }) },
  planted("frame", "guards see the Account before the frame (two views)", "two-views", "credit holds: nothing sent, in flight or staged exceeds the cap and the credits received"),
  planted("frame", "txs folded before hooks", "txs-before-hooks", "hooks are queued before the frame's own txs (R-E2)"),
  planted("frame", "proposals sorted by id, not first touch", "sorted-proposals", "Accounts propose in first-touch order, then the rest by id (R-E4)"),
  planted("frame", "arrivals folded in place among the txs", "arrivals-in-place", "a frame's outcome does not depend on where its arrivals sit among its txs (R-E1)"),
  { page: "runtime", name: "runtime tick", extra: [], expect: (r) => assert.deepEqual(r, { ok: true, states: 222, transitions: 520, goals: 6 }) },
  planted("runtime", "output leaves before its WAL row commits", "send-before-commit", "outputs leave only after their WAL row is committed"),
  planted("runtime", "a peer's invalid input halts the Runtime (og)", "bad-halts", "no peer input halts the Runtime: only local corruption does (R-X1)"),
  planted("runtime", "replay stamps frames with the current clock", "replay-wall-clock", "recovery reproduces the committed state"),
  planted("runtime", "frame timestamp is the input's own", "raw-input-timestamp", "the frame timestamp never goes back"),
  planted("runtime", "outputs are flushed newest first (t1)", "flush-out-of-order", "outputs reach the peer in row order: the peer holds a prefix of the WAL's outputs"),
  planted("runtime", "recovery believes replayed outputs already left (t2)", "recover-forgets-outputs", "no committed output is forgotten: the peer holds it or it is still to be sent"),
  planted("runtime", "a crash forgets the uncommitted input", "drop-uncommitted-input", "no input is lost: committed, staged, queued, or the halting one"),
  { page: "j", name: "J batch", extra: [], expect: (r) => assert.deepEqual(r, { ok: true, states: 12147, transitions: 38298, goals: 2036 }) },
  planted("j", "a finalize bundled with other dispute ops (N2)", "bundle-finalize", "a deadline revert never blocks another Account's ops: a reverted finalize goes alone"),
  planted("j", "a finalize lands at the deadline second (H1 off by one)", "h1-at-deadline", "a finalize lands only after the deadline or with the secret public (H1)"),
  { page: "j", name: "J batch, the secret may become public (H1)", extra: ["j/configs/public-secret.scm"], expect: (r) => assert.deepEqual(r, { ok: true, states: 12100, transitions: 35526, goals: 2868 }) },
  planted("j", "a finalize waits for the deadline although the secret is public (H1)", "h1-ignores-secret", "a finalize reverts only while the deadline is open and the secret is not public (H1)", "j/configs/public-secret.scm"),
  planted("j", "dispute and payment ops share a batch (R-SPLIT)", "mixed-batch", "deposit legs and dispute ops never share a batch with payment or settlement ops (R-SPLIT)"),
  planted("j", "an abandoned batch is re-signed with other content at its nonce (R-NONCE, F1)", "resign-at-nonce", "a signed batch is final at its nonce: no nonce is signed twice (R-NONCE, F1)"),
  planted("j", "an aborted batch requeues a deposit too (not idempotent)", "requeue-deposit", "no op is applied twice on chain"),
  planted("j", "a full draft halts the Entity (og)", "full-halts", "a full batch is a refusal, never a halt"),
  planted("j", "a stale dispute op reverts the whole batch (R-J2)", "stale-reverts", "a stale or already applied dispute op is skipped, never a revert of the batch (R-J2)"),
  planted("j", "the Entity does not read DisputeOpSkipped", "ignores-skip", "can always still finish"),
  { page: "j", name: "J batch, one payment batch fails (R-J5)", extra: ["j/configs/payment-failure.scm"], expect: (r) => assert.deepEqual(r, { ok: true, states: 9810, transitions: 30151, goals: 1840 }) },
  planted("j", "a failed batch takes no nonce and says nothing (contracts today, R-J5)", "failure-no-nonce", "a failed batch of payment, settlement and reserve ops takes its nonce: the chain has moved past it (R-J5)", "j/configs/payment-failure.scm"),
  { page: "j", name: "J batch, deposit legs and a bad counterparty signature (J5 refined)", extra: ["j/configs/legs-and-signatures.scm"], expect: (r) => assert.deepEqual(r, { ok: true, states: 34408, transitions: 126288, goals: 10112 }) },
  planted("j", "a deposit leg soft-fails and burns the Entity's nonce (J5 refined)", "leg-soft", "a failed batch with a deposit leg or a dispute op reverts whole and takes no nonce (R-J5 refined)", "j/configs/legs-and-signatures.scm"),
  planted("j", "a bad counterparty signature reverts the batch without its nonce (contracts today)", "bad-sig-hard", "a failed batch of payment, settlement and reserve ops takes its nonce: the chain has moved past it (R-J5)", "j/configs/legs-and-signatures.scm"),
  planted("j", "a co-signed op is bundled with another Account's ops (R-COSIGN)", "cosign-bundle", "a batch with a co-signed op carries ops of that one Account only (R-COSIGN)", "j/configs/legs-and-signatures.scm"),
  { page: "j", name: "J batch, gas starvation and a co-signed batch", extra: ["j/configs/gas-starvation.scm"], expect: (r) => assert.deepEqual(r, { ok: true, states: 6014, transitions: 17571, goals: 1544 }) },
  planted("j", "gas starvation is reported as BatchFailed and takes the nonce", "gas-soft", "gas below the floor (budget*64/63 + 30,000) spends no nonce, whatever the batch carries (contracts #54)", "j/configs/gas-starvation.scm"),
  { page: "j", name: "J batch, the counter lands before the finalize (R-J2 extended)", extra: ["j/configs/counter-first.scm"], expect: (r) => assert.deepEqual(r, { ok: true, states: 291, transitions: 691, goals: 68 }) },
  planted("j", "a finalize prepared for the initial proof applies after a counter landed", "finalize-after-counter", "a finalize prepared for the initial proof never applies after a counter landed (R-J2 extended)", "j/configs/counter-first.scm"),
  { page: "j", name: "J batch, two deposit legs (J6)", extra: ["j/configs/two-legs.scm"], expect: (r) => assert.deepEqual(r, { ok: true, states: 767, transitions: 2057, goals: 200 }) },
  planted("j", "two deposit legs share a batch (J6)", "legs-bundled", "a deposit leg travels alone in its batch (J6)", "j/configs/two-legs.scm"),
  planted("j", "the Entity does not read BatchFailed (R-J5)", "ignores-batch-failed", "can always still finish", "j/configs/payment-failure.scm"),
  planted("j", "the chain applies half a batch", "partial-apply", "the chain is atomic: every applied op came from a batch that succeeded", "j/configs/start-then-finalize.scm"),
  { page: "j", name: "J batch, a dispute start against a moved epoch (01:16)", extra: ["j/configs/epoch-start.scm"], expect: (r) => assert.deepEqual(r, { ok: true, states: 646, transitions: 1791, goals: 200 }) },
  planted("j", "a dispute start lands at another epoch", "start-ignores-epoch", "a dispute start lands only at the account epoch it was signed for; on a mismatch it is skipped (01:16)", "j/configs/epoch-start.scm"),
  { page: "j", name: "J batch, a start and a finalize in one batch", extra: ["j/configs/start-then-finalize.scm"], expect: (r) => assert.deepEqual(r, { ok: true, states: 343, transitions: 787, goals: 72 }) },
  { page: "j", name: "J batch, the Entity simulates before signing (01:16)", extra: ["j/configs/simulate-first.scm"], expect: (r) => assert.deepEqual(r, { ok: true, states: 317, transitions: 848, goals: 44 }) },
  planted("j", "a finalize is signed before its gate opened", "signs-before-gate", "a finalize is signed only after its gate opened when the Entity simulates first (Runtime rule, 01:16)", "j/configs/simulate-first.scm"),
  { page: "j", name: "J batch, the deposit token is paused: the deposit and the payments it funds wait (09-30 13:50)", extra: ["j/configs/paused-deposit.scm"], expect: (r) => assert.deepEqual(r, { ok: true, states: 983, transitions: 2850, goals: 208 }) },
  planted("j", "an unfunded payment is signed while the deposit waits", "unfunded-payments", "no signed batch carries an unfunded payment: each payment fits the spendable reserve, which nets all outstanding debt (R-FUNDED)", "j/configs/paused-deposit.scm"),
  planted("j", "a deposit is signed while its token is paused", "signs-paused-deposit", "a deposit whose token is paused is not signed: it is skipped and waits with the payments it funds (09-30 13:50)", "j/configs/paused-deposit.scm"),
  { page: "j", name: "J batch, debts cleared oldest first, one per call (09-30 13:50)", extra: ["j/configs/debts.scm"], expect: (r) => assert.deepEqual(r, { ok: true, states: 117, transitions: 342, goals: 12 }) },
  { page: "j", name: "J batch, debts and a payment the net reserve covers (09-30 13:50)", extra: ["j/configs/debts-funded.scm"], expect: (r) => assert.deepEqual(r, { ok: true, states: 317, transitions: 886, goals: 80 }) },
  planted("j", "the Entity counts owed money as spendable", "spends-owed-reserve", "no signed batch carries an unfunded payment: each payment fits the spendable reserve, which nets all outstanding debt (R-FUNDED)", "j/configs/debts.scm"),
  planted("j", "the chain pays the newest debt first", "debts-lifo", "debts are cleared oldest first", "j/configs/debts.scm"),
  planted("j", "one enforcement call has no cap", "debts-uncapped", "one enforcement call visits at most the cap of claims, cleared or part-paid (32 in the contract)", "j/configs/debts.scm"),
  planted("j", "a debt is cleared and not paid", "debts-cleared-unpaid", "a debt leaves the queue only when paid or forgiven: paid, forgiven and outstanding equal the debts the entity started with", "j/configs/debts.scm"),
  { page: "j", name: "J batch, R-FUNDED: the payment that fits goes out, the one that does not waits (09-30 15:23)", extra: ["j/configs/funded-order.scm"], expect: (r) => assert.deepEqual(r, { ok: true, states: 39, transitions: 78, goals: 12 }) },
  { page: "j", name: "J batch, WITNESS R-FUNDED: a payment is skipped while a later one is signed", extra: ["j/configs/funded-order.scm", "j/configs/funded-order-witness.scm"], expect: (r) => assert.equal(r.violated, "witness R-FUNDED: a payment that does not fit is skipped while a later one is signed") },
  planted("j", "the planner stops at the first payment that does not fit", "funding-blocks-behind-misfit", "can always still finish", "j/configs/funded-order.scm"),
  { page: "j", name: "J batch, R-FUNDED without a deposit: an unfunded payment is never signed (09-30 15:23)", extra: ["j/configs/unfunded-alone.scm"], expect: (r) => assert.deepEqual(r, { ok: true, states: 6, transitions: 7, goals: 3 }) },
  planted("j", "an unfunded payment is signed with no deposit in play", "unfunded-payments", "no signed batch carries an unfunded payment: each payment fits the spendable reserve, which nets all outstanding debt (R-FUNDED)", "j/configs/unfunded-alone.scm"),
  { page: "j", name: "J batch, R2C-DEBT-FIRST: a reserve payment enforces the queue first (09-30 15:23)", extra: ["j/configs/r2c-debt-first.scm"], expect: (r) => assert.deepEqual(r, { ok: true, states: 108, transitions: 243, goals: 36 }) },
  { page: "j", name: "J batch, WITNESS R2C-DEBT-FIRST: the queue is enforced in two internal calls", extra: ["j/configs/r2c-debt-first.scm", "j/configs/r2c-debt-first-witness.scm"], expect: (r) => assert.equal(r.violated, "witness R2C-DEBT-FIRST: a reserve payment enforces the queue in two internal calls") },
  planted("j", "a reserve payment skips the debt enforcement", "r2c-skips-enforcement", "after a reserve-to-collateral op, the debt queue is empty or the spendable reserve is zero (R2C-DEBT-FIRST)", "j/configs/r2c-debt-first.scm"),
  { page: "j", name: "J batch, a part-paid claim stays at the head (09-30 15:23)", extra: ["j/configs/debts-partial.scm"], expect: (r) => assert.deepEqual(r, { ok: true, states: 36, transitions: 73, goals: 12 }) },
  { page: "j", name: "J batch, WITNESS: a claim is part-paid", extra: ["j/configs/debts-partial.scm", "j/configs/debts-partial-witness.scm"], expect: (r) => assert.equal(r.violated, "witness: a claim is part-paid and stays at the head") },
  planted("j", "a part-paid claim moves to the back of the queue", "partial-moves-back", "a part-paid claim stays at the head of the queue, reduced in place (contracts f996ff5)", "j/configs/debts-partial.scm"),
  { page: "j", name: "J batch, gas by batch kind: a starved payment emits BatchGasStarved, a starved deposit reverts whole (09-30 16:12)", extra: ["j/configs/gas-kinds.scm"], expect: (r) => assert.deepEqual(r, { ok: true, states: 2365, transitions: 6586, goals: 492 }) },
  { page: "j", name: "J batch, WITNESS: a starved money-only batch emits BatchGasStarved", extra: ["j/configs/gas-kinds.scm", "j/configs/gas-kinds-witness.scm"], expect: (r) => assert.equal(r.violated, "witness: a starved money-only batch emits BatchGasStarved") },
  planted("j", "a starved money-only batch emits nothing", "starved-silent", "a money-only batch starved of gas emits BatchGasStarved; a batch with a dispute, reveal, ladder or deposit op reverts whole and emits nothing (contracts #54)", "j/configs/gas-kinds.scm"),
  planted("j", "a starved deposit batch emits BatchGasStarved", "hard-starved-event", "a money-only batch starved of gas emits BatchGasStarved; a batch with a dispute, reveal, ladder or deposit op reverts whole and emits nothing (contracts #54)", "j/configs/gas-kinds.scm"),
  planted("j", "the floor itself counts as starved", "starved-at-floor", "a batch given at least the floor is never gas-starved: it runs, and a failure is BatchFailed with the nonce spent (contracts #54)", "j/configs/gas-kinds.scm"),
  { page: "j", name: "J batch, a settlement forgives the head claim (09-30 16:12)", extra: ["j/configs/forgive-head.scm"], expect: (r) => assert.deepEqual(r, { ok: true, states: 36, transitions: 73, goals: 12 }) },
  { page: "j", name: "J batch, WITNESS: a settlement forgives the head claim", extra: ["j/configs/forgive-head.scm", "j/configs/forgive-head-witness.scm"], expect: (r) => assert.equal(r.violated, "witness: a settlement forgives the head claim") },
  { page: "j", name: "J batch, a third party's claim at the head reverts the whole settlement (09-30 16:12)", extra: ["j/configs/forgive-third-head.scm"], expect: (r) => assert.deepEqual(r, { ok: true, states: 52, transitions: 101, goals: 20 }) },
  { page: "j", name: "J batch, WITNESS: a settlement failed on a third party's head claim", extra: ["j/configs/forgive-third-head.scm", "j/configs/forgive-third-head-witness.scm"], expect: (r) => assert.equal(r.violated, "witness: a settlement failed on a third party's head claim") },
  { page: "j", name: "J batch, a settlement that lists more ids than the cap reverts whole (09-30 16:12)", extra: ["j/configs/forgive-cap.scm"], expect: (r) => assert.deepEqual(r, { ok: true, states: 52, transitions: 101, goals: 20 }) },
  { page: "j", name: "J batch, a listed claim behind the head is not deleted (09-30 16:12)", extra: ["j/configs/forgive-past-head.scm"], expect: (r) => assert.deepEqual(r, { ok: true, states: 36, transitions: 73, goals: 12 }) },
  planted("j", "a settlement deletes a claim owed to a third party", "forgives-third-party", "a settlement deletes only the head claim of the queue, and only when its creditor is the settling counterparty (contracts #54)", "j/configs/forgive-third-head.scm"),
  planted("j", "a settlement deletes a claim behind the head", "forgives-past-head", "a settlement deletes only the head claim of the queue, and only when its creditor is the settling counterparty (contracts #54)", "j/configs/forgive-past-head.scm"),
  planted("j", "a third party's head claim ends the walk instead of reverting", "forgiveness-skips-third-party", "a settlement whose forgiveness reaches a third party's claim at the head never lands: it reverts whole (contracts #54)", "j/configs/forgive-third-head.scm"),
  planted("j", "a settlement lists more ids than the cap", "forgive-uncapped", "a settlement that lands lists at most the cap of claim ids (32 in the contract) (contracts #54)", "j/configs/forgive-cap.scm"),
  { page: "routing", name: "routing", extra: [], expect: (r) => assert.deepEqual(r, { ok: true, states: 2779, transitions: 2853, goals: 0 }) },
  { page: "routing", name: "routing, inbound lock beyond MAX_LOCK_HORIZON (N2)", extra: ["entity/configs/far-inbound.scm"], expect: (r) => assert.deepEqual(r, { ok: true, states: 16, transitions: 15, goals: 0 }) },
  planted("routing", "a hub forwards a lock beyond MAX_LOCK_HORIZON (N2)", "no-horizon", "no lock is forwarded whose deadline is beyond MAX_LOCK_HORIZON (N2, deadline_too_far)", "entity/configs/far-inbound.scm"),
  planted("routing", "no hop margin between the locks (R1)", "no-hop-margin", "H never pays B without being paid by A: a diligent hub cannot lose"),
  planted("routing", "fail-back before the chain fact can be seen (R2)", "early-failback", "H never pays B without being paid by A: a diligent hub cannot lose"),
  planted("routing", "a dispute start leaves a known secret out (R3)", "dispute-omits-secret", "a dispute start publishes every secret H knows (R3)"),
  planted("routing", "R3 without its own property: the loss property kills the omission (B4)", "dispute-omits-secret", "H never pays B without being paid by A: a diligent hub cannot lose", "entity/configs/no-r3-property.scm"),
  planted("money", "deposit from nowhere", "deposit-from-nowhere", "r2c / c2r: one unit between the payer's reserve and the collateral; a Left deposit is Left's allocation"),
  planted("money", "the shared payment arithmetic moves Δ the wrong way (money/core.scm)", "core-pay-flipped", "pay n: the payer's allocation falls by n; nothing else moves"),
  planted("money", "the shared credit bound has no lower side (money/core.scm)", "core-rcpan-no-floor", "credit holds: RCPAN in the worst case over the open clauses"),
];

// One process per case (the interpreter is single-threaded): `node test.mjs` runs them all in
// parallel; `node test.mjs <n>` runs case n and prints its JSON verdict.
const only = process.argv[2];
if (only !== undefined) {
  const c = cases[Number(only)];
  const result = await check(c.page, c.extra);
  c.expect(result);
  console.log(JSON.stringify({ name: c.name, result }));
} else {
  const run = (i) =>
    new Promise((resolve, reject) =>
      execFile(process.execPath, [fileURLToPath(import.meta.url), String(i)], { maxBuffer: 1 << 26 }, (error, stdout, stderr) =>
        error ? reject(new Error(`case ${i} (${cases[i].name}) failed:\n${stderr || stdout}`)) : resolve(JSON.parse(stdout)),
      ),
    );
  // a pool, not all at once: three full suites at once ran a 16 GB container out of memory. The
  // heavy cases (the pages themselves, no planted bug) start first.
  const jobs = Number(process.env.TEST_JOBS ?? 4);
  const order = cases.map((_, i) => i).sort((a, b) => Number(cases[a].extra.length > 0) - Number(cases[b].extra.length > 0));
  const results = new Array(cases.length);
  const failures = [];
  const next = { i: 0 };
  // a failing case is reported at the end; the rest still run, so one run shows every failure
  const worker = async () => {
    for (let k = next.i++; k < order.length; k = next.i++) {
      try {
        results[order[k]] = await run(order[k]);
      } catch (e) {
        failures.push(`FAIL ${cases[order[k]].name}\n${String(e.message).split("\n").filter((l) => /^[+-] |actual|expected/.test(l)).join("\n")}`);
      }
    }
  };
  await Promise.all(Array.from({ length: jobs }, worker));
  results.forEach(({ name, result }) =>
    console.log(`ok   ${name}${result.trace ? ` — ${result.violated}\n       ${result.trace.join(" → ")}` : ` — ${result.states} states`}`),
  );
  failures.forEach((f) => console.log(f));
  if (failures.length) process.exitCode = 1;
}
