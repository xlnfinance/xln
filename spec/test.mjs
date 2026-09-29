// Spec self-test: the Account frames page checks clean, and each planted bug is caught
// by the property it breaks. Run from spec/: node test.mjs
import { evaluate, lib } from "./tools/run.mjs";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";

const page = [...lib, "account/frames.scm"];
const check = (extra) => evaluate([...page, ...extra], "(check account-frames)");

const planted = (name, file, violated) => ({
  name: `planted: ${name}`,
  extra: [`account/bugs/${file}.scm`],
  expect: (r) => assert.equal(r.violated, violated),
});

const cases = [
  { name: "account frames", extra: [], expect: (r) => assert.deepEqual(r, { ok: true, states: 3651, transitions: 11335, goals: 16 }) },
  planted("drop on rollback", "drop-on-rollback", "no submitted tx is lost: committed, held, or refused"),
  planted("rollback after mempool", "rollback-after-mempool", "each side's txs commit in submission order"),
  planted("no tie-break", "no-tie-break", "committed histories agree: one extends the other"),
  planted("no re-ack of a duplicate", "no-reack", "can always still finish"),
  planted("commit a frame that skips ahead", "commit-any-frame", "no tx is both committed and refused"),
  planted("skip re-validation", "skip-revalidation", "can always still finish"),
];

// One process per case (the interpreter is single-threaded): `node test.mjs` runs them all in
// parallel; `node test.mjs <n>` runs case n and prints its JSON verdict.
const only = process.argv[2];
if (only !== undefined) {
  const c = cases[Number(only)];
  const result = await check(c.extra);
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
