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
  j: { files: ["j/batch.scm"], spec: "j-batch" },
};
const check = (page, extra) => evaluate([...lib, ...pages[page].files, ...extra], `(check ${pages[page].spec})`);

const planted = (page, name, file, violated) => ({
  page,
  name: `planted: ${name}`,
  extra: [`${page}/bugs/${file}.scm`],
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
  { page: "dispute", name: "dispute", extra: [], expect: (r) => assert.deepEqual(r, { ok: true, states: 4029, transitions: 7686, goals: 2075 }) },
  planted("dispute", "finalize a stale start before T", "early-finalize", "the responder is never worse off than the newest proof it held"),
  planted("dispute", "no floor on the response windows", "no-floor", "the responder is never worse off than the newest proof it held"),
  planted("dispute", "Right outranks Left at an equal nonce", "tie-break-inverted", "an honest starter never ends on a losing proposal"),
  planted("dispute", "no H1 wait for an HTLC deadline", "no-h1", "an HTLC is never settled as unpaid before its deadline"),
  planted("dispute", "Left paid past the collateral", "payout-no-cap", "a dispute pays out what the selected state says: net left + Δ, net right + collateral - Δ"),
  planted("dispute", "proof of an old epoch still pays", "no-epoch", "only a proof of the current epoch pays out"),
  planted("dispute", "baseline of the next epoch too low", "baseline-too-low", "after an epoch advance each side still holds a valid proof of the new epoch"),
  { page: "entity", name: "entity consensus", extra: [], expect: (r) => assert.deepEqual(r, { ok: true, states: 778, transitions: 2565, goals: 264 }) },
  planted("entity", "own proposal kept on a conflicting certified frame (og today)", "commit-conflict", "can always still finish"),
  planted("entity", "own proposal dropped, its txs forgotten", "drop-txs-on-conflict", "no submitted tx is lost"),
  planted("entity", "a validator signs two frames at one height", "double-sign", "agreement: no two validators commit different frames at a height"),
  { page: "j", name: "J batch", extra: [], expect: (r) => assert.deepEqual(r, { ok: true, states: 5262, transitions: 17049, goals: 736 }) },
  planted("j", "a finalize bundled with other ops (N2)", "bundle-finalize", "a deadline revert never blocks another Account's ops: a reverted finalize goes alone"),
  planted("j", "a quarantined batch is never recovered (og, non-hub)", "no-recovery", "can always still finish"),
  planted("j", "an event does not clear the draft", "trust-the-draft", "no op is applied twice on chain"),
  planted("j", "a full draft halts the Entity (og)", "full-halts", "a full batch is a refusal, never a halt"),
  planted("j", "the chain applies half a batch", "partial-apply", "the chain is atomic: every applied op came from a batch that succeeded"),
  planted("money", "deposit from nowhere", "deposit-from-nowhere", "money is conserved: reserves + collateral never change"),
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
  const results = await Promise.all(cases.map((_, i) => run(i)));
  results.forEach(({ name, result }) =>
    console.log(`ok   ${name}${result.trace ? ` — ${result.violated}\n       ${result.trace.join(" → ")}` : ` — ${result.states} states`}`),
  );
}
