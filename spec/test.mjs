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
  money: { files: ["money/ledger.scm"], spec: "ledger" },
  dispute: { files: ["dispute/dispute.scm"], spec: "dispute" },
  entity: { files: ["entity/consensus.scm"], spec: "entity-consensus" },
  frame: { files: ["entity/frame.scm"], spec: "entity-frame" },
  runtime: { files: ["runtime/tick.scm"], spec: "runtime" },
  j: { files: ["j/batch.scm"], spec: "j-batch" },
  routing: { files: ["entity/routing.scm"], spec: "routing" },
};
const check = (page, extra) => evaluate([...lib, ...pages[page].files, ...extra], `(check ${pages[page].spec})`);

const planted = (page, name, file, violated, config) => ({
  page,
  name: `planted: ${name}`,
  extra: [...(config ? [config] : []), `${pages[page].files[0].split("/")[0]}/bugs/${file}.scm`],
  expect: (r) => assert.equal(r.violated, violated),
});

const cases = [
  { page: "account", name: "account frames", extra: [], expect: (r) => assert.deepEqual(r, { ok: true, states: 3651, transitions: 11335, goals: 16 }) },
  planted("account", "drop on rollback", "drop-on-rollback", "no submitted tx is lost: committed, held, or refused"),
  planted("account", "rollback after mempool", "rollback-after-mempool", "each side's txs commit in submission order"),
  planted("account", "no tie-break", "no-tie-break", "committed histories agree: one extends the other"),
  planted("account", "no re-ack of a duplicate", "no-reack", "can always still finish"),
  planted("account", "commit a frame that skips ahead", "commit-any-frame", "no tx is both committed and refused"),
  planted("account", "skip re-validation", "skip-revalidation", "can always still finish"),
  { page: "money", name: "money ledger", extra: [], expect: (r) => assert.deepEqual(r, { ok: true, states: 820, transitions: 7094, goals: 0 }) },
  planted("money", "ignore open clauses in the guard", "ignore-clauses", "credit holds: RCPAN in the worst case over the open clauses"),
  planted("money", "credit lowered below usage", "credit-below-usage", "credit holds: RCPAN in the worst case over the open clauses"),
  planted("money", "a payment moves the allocation the wrong way", "pay-wrong-way", "pay n: the payer's allocation falls by n; nothing else moves"),
  planted("money", "a resolved clause lands on the wrong side", "resolve-wrong-side", "resolve: the clause pays, Δ moves against its payer by its amount"),
  planted("money", "a lapsed clause pays out", "expire-pays", "expire: the clause lapses, Δ and the money stay"),
  planted("money", "a Left deposit does not raise ondelta", "deposit-no-ondelta", "r2c / c2r: one unit between the payer's reserve and the collateral; a Left deposit is Left's allocation"),
  { page: "dispute", name: "dispute", extra: [], expect: (r) => assert.deepEqual(r, { ok: true, states: 9771, transitions: 16667, goals: 5430 }) },
  planted("dispute", "finalize a stale start before T", "early-finalize", "the responder is never worse off than the newest proof it held"),
  planted("dispute", "no floor on the response windows", "no-floor", "the responder is never worse off than the newest proof it held"),
  planted("dispute", "Right outranks Left at an equal nonce", "tie-break-inverted", "an honest starter never ends on a losing proposal"),
  planted("dispute", "no H1 wait for an HTLC deadline", "no-h1", "an HTLC is never settled as unpaid before its deadline"),
  planted("dispute", "Left paid past the collateral", "payout-no-cap", "a dispute pays out what the selected state says: net left + Δ, net right + collateral - Δ"),
  planted("dispute", "proof of an old epoch still pays", "no-epoch", "only a proof of the current epoch pays out"),
  planted("dispute", "baseline of the next epoch too low", "baseline-too-low", "after an epoch advance each side still holds a valid proof of the new epoch"),
  planted("dispute", "the receiver signs a body it did not recompute", "blind-sign", "both sides sign the same proof: proofs of one nonce, proposer and kind have one body"),
  planted("dispute", "nobody checks RCPAN before signing a frame", "no-rcpan", "credit holds: what a side owes never exceeds the credit extended to it"),
  planted("dispute", "an ack lands after the response window (Q-D-3)", "late-ack", "a dispute pays what both sides had committed: the final proof ranks at least the newest frame proposed by T"),
  planted("dispute", "a response window at or below LAG (R-C11)", "window-below-lag", "the responder is never worse off than the newest proof it held"),
  planted("dispute", "a shortfall taken past the reserve", "shortfall-uncapped", "no reserve, collateral or debt is ever negative"),
  planted("dispute", "a secret at the deadline second does not pay", "secret-strict", "a clause pays exactly when its secret was public by the deadline"),
  planted("dispute", "a secret after the deadline pays", "secret-any-time", "a clause pays exactly when its secret was public by the deadline"),
  planted("dispute", "final Δ forgets ondelta", "delta-drops-ondelta", "Δ = ondelta + offdelta, less the clause if it paid"),
  planted("dispute", "a paid HTLC moves Δ the wrong way", "htlc-sign-flipped", "Δ = ondelta + offdelta, less the clause if it paid"),
  planted("dispute", "a timeout finalize does not consume a nonce", "chain-nonce-stale", "a timeout finalize consumes exactly one nonce; an adopted proof sets it"),
  { page: "entity", name: "entity consensus", extra: [], expect: (r) => assert.deepEqual(r, { ok: true, states: 6726, transitions: 29745, goals: 2060 }) },
  planted("entity", "own proposal kept on a conflicting certified frame (og today)", "commit-conflict", "can always still finish"),
  planted("entity", "own proposal dropped, its txs forgotten", "drop-txs-on-conflict", "no submitted tx is lost"),
  planted("entity", "a validator signs two frames at one height", "double-sign", "agreement: no two validators commit different frames at a height"),
  planted("entity", "installing a frame does not move the view (Q-E-6)", "no-view-sync", "can always still finish"),
  planted("entity", "a proposal for a future height is dropped (Q-E-7)", "drop-future", "can always still finish"),
  planted("entity", "installing a frame keeps its txs in the mempool", "install-keeps-mempool", "no tx is committed twice"),
  planted("entity", "a forwarded tx already committed is queued again", "fwd-no-dedup", "no tx is committed twice"),
  planted("entity", "a conflict keeps the signature on the old proposal", "conflict-keeps-signed", "a signature is for the height being decided: it is dropped when that height is committed"),
  { page: "frame", name: "entity frame", extra: [], expect: (r) => assert.deepEqual(r, { ok: true, states: 1770, transitions: 2228, goals: 1158 }) },
  planted("frame", "guards see the Account before the frame (two views)", "two-views", "credit holds: nothing sent, in flight or staged exceeds the cap and the credits received"),
  planted("frame", "txs folded before hooks", "txs-before-hooks", "hooks are queued before the frame's own txs (R-E2)"),
  planted("frame", "proposals sorted by id, not first touch", "sorted-proposals", "Accounts propose in first-touch order, then the rest by id (R-E4)"),
  planted("frame", "arrivals folded in place among the txs", "arrivals-in-place", "a frame's outcome does not depend on where its arrivals sit among its txs (R-E1)"),
  { page: "runtime", name: "runtime tick", extra: [], expect: (r) => assert.deepEqual(r, { ok: true, states: 162, transitions: 378, goals: 6 }) },
  planted("runtime", "output leaves before its WAL row commits", "send-before-commit", "outputs leave only after their WAL row is committed"),
  planted("runtime", "a peer's invalid input halts the Runtime (og)", "bad-halts", "no peer input halts the Runtime: only local corruption does (R-X1)"),
  planted("runtime", "replay stamps frames with the current clock", "replay-wall-clock", "recovery reproduces the committed state"),
  planted("runtime", "frame timestamp is the input's own", "raw-input-timestamp", "the frame timestamp never goes back"),
  planted("runtime", "a crash forgets the uncommitted input", "drop-uncommitted-input", "no input is lost: committed, staged, queued, or the halting one"),
  { page: "j", name: "J batch", extra: [], expect: (r) => assert.deepEqual(r, { ok: true, states: 4891, transitions: 15651, goals: 848 }) },
  planted("j", "a finalize bundled with other dispute ops (N2)", "bundle-finalize", "a deadline revert never blocks another Account's ops: a reverted finalize goes alone"),
  planted("j", "dispute and payment ops share a batch (R-SPLIT)", "mixed-batch", "dispute ops never share a batch with payment ops (R-SPLIT)"),
  planted("j", "an abandoned batch is re-signed with other content at its nonce (R-NONCE, F1)", "resign-at-nonce", "a signed batch is final at its nonce: no nonce is signed twice (R-NONCE, F1)"),
  planted("j", "an aborted batch requeues a deposit too (not idempotent)", "requeue-deposit", "no op is applied twice on chain"),
  planted("j", "a full draft halts the Entity (og)", "full-halts", "a full batch is a refusal, never a halt"),
  planted("j", "a stale dispute op reverts the whole batch (R-J2)", "stale-reverts", "a stale or already applied dispute op is skipped, never a revert of the batch (R-J2)"),
  planted("j", "the Entity does not read DisputeOpSkipped", "ignores-skip", "can always still finish"),
  { page: "j", name: "J batch, one payment batch fails (R-J5)", extra: ["j/configs/payment-failure.scm"], expect: (r) => assert.deepEqual(r, { ok: true, states: 4528, transitions: 13917, goals: 840 }) },
  planted("j", "a failed batch takes no nonce and says nothing (contracts today, R-J5)", "failure-no-nonce", "a failed batch takes its nonce: the chain has moved past it (R-J5)", "j/configs/payment-failure.scm"),
  planted("j", "the Entity does not read BatchFailed (R-J5)", "ignores-batch-failed", "can always still finish", "j/configs/payment-failure.scm"),
  planted("j", "the chain applies half a batch", "partial-apply", "the chain is atomic: every applied op came from a batch that succeeded"),
  { page: "routing", name: "routing", extra: [], expect: (r) => assert.deepEqual(r, { ok: true, states: 4698, transitions: 4932, goals: 0 }) },
  planted("routing", "no hop margin between the locks (R1)", "no-hop-margin", "H never pays B without being paid by A: a diligent hub cannot lose"),
  planted("routing", "fail-back before the chain fact can be seen (R2)", "early-failback", "H never pays B without being paid by A: a diligent hub cannot lose"),
  planted("routing", "a dispute start leaves a known secret out (R3)", "dispute-omits-secret", "a dispute start publishes every secret H knows (R3)"),
  planted("money", "deposit from nowhere", "deposit-from-nowhere", "r2c / c2r: one unit between the payer's reserve and the collateral; a Left deposit is Left's allocation"),
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
  const next = { i: 0 };
  const worker = async () => {
    for (let k = next.i++; k < order.length; k = next.i++) results[order[k]] = await run(order[k]);
  };
  await Promise.all(Array.from({ length: jobs }, worker));
  results.forEach(({ name, result }) =>
    console.log(`ok   ${name}${result.trace ? ` — ${result.violated}\n       ${result.trace.join(" → ")}` : ` — ${result.states} states`}`),
  );
}
