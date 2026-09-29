// Spec self-test: the Account frames page checks clean, and each planted bug is caught
// by the property it breaks. Run from spec/: node test.mjs
import { execState, toJS, LexicalScope } from "./arrival/packages/arrival/dist/index.js";
import { overridableCapability } from "./arrival/packages/arrival/dist/env/overridable/overridable.js";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";

const page = ["lib/vocabulary.scm", "lib/check.scm", "account/frames.scm"];

const check = async (extra) => {
  const scope = LexicalScope.fresh("spec-test");
  const source = [...page, ...extra].map((f) => readFileSync(f, "utf8")).join("\n");
  const { values } = await execState(`${source}\n(check account-frames)`, { scope, capabilities: [overridableCapability] });
  return toJS(values.at(-1));
};

const cases = [
  { name: "account frames", extra: [], expect: (r) => assert.deepEqual(r, { ok: true, states: 313, transitions: 557 }) },
  {
    name: "planted: drop on rollback",
    extra: ["account/bugs/drop-on-rollback.scm"],
    expect: (r) => assert.equal(r.violated, "no submitted tx is lost"),
  },
  {
    name: "planted: rollback after mempool",
    extra: ["account/bugs/rollback-after-mempool.scm"],
    expect: (r) => assert.equal(r.violated, "each side's txs commit in submission order"),
  },
  {
    name: "planted: no tie-break",
    extra: ["account/bugs/no-tie-break.scm"],
    expect: (r) => assert.equal(r.violated, "committed histories agree: one extends the other"),
  },
];

const results = await Promise.all(cases.map(async (c) => ({ ...c, result: await check(c.extra) })));
results.forEach(({ name, result, expect }) => {
  expect(result);
  console.log(`ok   ${name}${result.trace ? ` — ${result.violated}\n       ${result.trace.join(" → ")}` : ` — ${result.states} states`}`);
});
