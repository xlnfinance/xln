// @values / @entries — polyglot.ts's newest member-access verbs, siblings of @/@?/@keys.
//
// Both read a receiver's OWN members through its OWN `arrival/tagless-final/keys`/`get`
// terms (the shared `collectMembers` helper) — never through toJS/jsToScheme
// round-tripping (polyglot.ts's own header note on why: a borrowed store re-crossed
// that way could carry AValues into JS-world storage). This file proves the OBSERVABLE
// half of that contract across every receiver kind the protocol claims to support:
// a `{…}` dict literal, a borrowed JS object, and a borrowed JS array.
//
// THE ORACLE (per the task brief): never hand-write an expected values/entries list.
// `@keys` + `@` (read one key at a time) is the ground truth every `@values`/`@entries`
// call is checked against — a differential test, not a property test, so a values-vs-
// entries mismatch or an order flip cannot hide behind a "looks reasonable" assertion.
import { describe, expect, it } from "vitest";

import type { ResolvingAmbient } from "../../AmbientRuntime.js";
import { CONSTANT_CTX } from "../../../run/RunContext.js";
import { execOverFrame as exec, execStateOverFrame as execState } from "../../../eval/generator-exec.js";
import { inferenceEnv } from "../../inference-env.js";
import { jsToScheme, toJS } from "../../../membrane/rosetta.js";
import type { SchemeValue } from "../../../values/types.js";

let scratchCounter = 0;
/** Every fixture gets its own frame name — cheap, avoids any risk of cross-case bleed. */
function envWithObj(obj: SchemeValue): ResolvingAmbient {
  return inferenceEnv.child(`values-entries-${scratchCounter++}`, { obj });
}

/** The oracle walk: one `@keys` call, then one `@` per key, driven from the TEST side so the
 *  per-key reads stay independent of whatever `@values` does internally. All three member
 *  verbs answer an owned vector; the keys are unwrapped here rather than folded in scheme, to
 *  keep the oracle free of the verbs under test. */
async function keysAndOracleValues(env: ResolvingAmbient): Promise<{ keys: string[]; oracleValues: unknown[] }> {
  const keysState = await execState(`(@keys obj)`, { env });
  const rawKeys = toJS(keysState.values[0], {}) as unknown[];
  const keys = rawKeys.map((k) => String(k));
  const oracleValues: unknown[] = [];
  for (const k of keys) {
    const r = await execState(`(@ obj ${JSON.stringify(k)})`, { env });
    oracleValues.push(toJS(r.values[0], {}));
  }
  return { keys, oracleValues };
}

async function actualValues(env: ResolvingAmbient): Promise<unknown[]> {
  const r = await execState(`(@values obj)`, { env });
  return toJS(r.values[0], {}) as unknown[];
}

/** `@entries` walked ENTIRELY through scheme `car`/`cdr` on each vector slot — NOT
 *  `toJS` on the whole entry. APair's own `arrival/toJS` crosses to a 2-element
 *  JS array regardless of whether the pair is a real dotted pair or a proper 2-list, so
 *  unwrapping the whole entry would hide exactly the regression this file exists to
 *  catch. `car`/`cdr`, called separately, cannot: `cdr` of a 2-list is a 1-list (an
 *  APair, `pair?` true), `cdr` of a dotted pair is the value itself. */
async function entryAt(env: ResolvingAmbient, i: number): Promise<{ key: unknown; value: unknown }> {
  const keyState = await execState(`(car (vector-ref (@entries obj) ${i}))`, { env });
  const valueState = await execState(`(cdr (vector-ref (@entries obj) ${i}))`, { env });
  return { key: toJS(keyState.values[0], {}), value: toJS(valueState.values[0], {}) };
}

/** `(dict "a" 1 "b" 2 ...)` — a genuine ADict, built through the real scheme
 *  constructor (not hand-assembled) so the fixture matches how the pack itself
 *  documents dicts being made. */
async function mintDict(pairs: Record<string, number>): Promise<SchemeValue> {
  const args = Object.entries(pairs)
    .map(([k, v]) => `${JSON.stringify(k)} ${v}`)
    .join(" ");
  const state = await execState(`(dict ${args})`, { env: inferenceEnv.child(`dict-mint-${scratchCounter++}`) });
  return state.values[0]!;
}

// ─── receivers this file exercises, one row of fixtures reused by every case ───────
const RECEIVERS: Array<{ label: string; mkObj: () => Promise<SchemeValue> }> = [
  { label: "a {…} dict literal (built via the real `dict` constructor)", mkObj: () => mintDict({ a: 1, b: 2, c: 3 }) },
  { label: "a borrowed JS object", mkObj: async () => jsToScheme(CONSTANT_CTX, { x: 10, y: 20, z: 30 }) },
  { label: "a borrowed JS array", mkObj: async () => jsToScheme(CONSTANT_CTX, [100, 200, 300]) },
];

describe("@values — own member values, as a vector, in @keys order", () => {
  for (const { label, mkObj } of RECEIVERS) {
    it(`${label}: @values matches the @keys+@ oracle, in order`, async () => {
      const env = envWithObj(await mkObj());
      const { oracleValues } = await keysAndOracleValues(env);
      const actual = await actualValues(env);
      expect(actual).toEqual(oracleValues);
      expect(actual.length).toBeGreaterThan(0); // the fixtures are all non-empty — a real check, not vacuous
    });
  }

  it("the result is a vector, never a pair", async () => {
    const env = envWithObj(await mintDict({ a: 1 }));
    expect((await exec(`(vector? (@values obj))`, { env }))[0]).toBe(true);
    expect((await exec(`(pair? (@values obj))`, { env }))[0]).toBe(false);
  });

  it('nested read composes: (@ (car (@values obj)) "somekey") reaches into a nested record', async () => {
    const env = envWithObj(jsToScheme(CONSTANT_CTX, { a: { somekey: 42 } }));
    // loose-mode car reads a vector's first slot (projection-nil-tolerance.test.ts's
    // own convention) — the first (only) value here is the nested record.
    const [v] = await exec(`(@ (car (@values obj)) "somekey")`, { env });
    expect(Number(v)).toBe(42);
  });
});

describe("@entries — own members as (key . value) DOTTED pairs, in a vector", () => {
  for (const { label, mkObj } of RECEIVERS) {
    it(`${label}: entry count matches @keys; each (car . cdr) matches the @keys+@ oracle`, async () => {
      const env = envWithObj(await mkObj());
      const { keys, oracleValues } = await keysAndOracleValues(env);
      const countState = await execState(`(vector-length (@entries obj))`, { env });
      expect(Number(countState.values[0])).toBe(keys.length);

      const entries = await Promise.all(keys.map((_, i) => entryAt(env, i)));
      expect(entries.map((e) => e.key)).toEqual(keys);
      expect(entries.map((e) => e.value)).toEqual(oracleValues);
    });
  }

  // THE distinguishing assertion from the task brief, pinned literally: a member is a
  // 2-product with no tail — ONE cons cell — so `(cdr entry)` is the value itself, never
  // a 1-element list wrapping it.
  it('(cdr (car (@entries {"a": 1}))) is 1, not (1) — the dotted-pair, not a 2-list', async () => {
    const env = envWithObj(await mintDict({ a: 1 }));
    const [isRawValue] = await exec(`(equal? (cdr (car (@entries obj))) 1)`, { env });
    expect(isRawValue).toBe(true);
    const [isWronglyListWrapped] = await exec(`(equal? (cdr (car (@entries obj))) (list 1))`, { env });
    expect(isWronglyListWrapped).toBe(false);
    // Confirms the SHAPE, not just the value: cdr of a genuine dotted pair holding a
    // non-pair value is itself non-pair. A 2-list regression would make this `#t`.
    const [cdrIsPair] = await exec(`(pair? (cdr (car (@entries obj))))`, { env });
    expect(cdrIsPair).toBe(false);
  });

  it("the collection itself is a vector, never a pair", async () => {
    const env = envWithObj(await mintDict({ a: 1 }));
    expect((await exec(`(vector? (@entries obj))`, { env }))[0]).toBe(true);
    expect((await exec(`(pair? (@entries obj))`, { env }))[0]).toBe(false);
  });

  it("each entry itself IS a pair (assoc-compatible)", async () => {
    const env = envWithObj(await mintDict({ a: 1, b: 2 }));
    const [firstIsPair] = await exec(`(pair? (vector-ref (@entries obj) 0))`, { env });
    expect(firstIsPair).toBe(true);
    // assoc-compatible: (assoc "a" (vector->list (@entries obj))) finds the "a" entry
    // and hands back the SAME (key . value) shape assoc always returns.
    const [found] = await exec(`(assoc "a" (vector->list (@entries obj)))`, { env });
    expect(String(found)).toContain("1");
  });
});

describe("@values / @entries — term-less receiver ⇒ empty vector (absence is the semantics)", () => {
  const TERMLESS: [string, string][] = [
    ["a number", "42"],
    ["a string", '"hello"'],
    ["a lambda", "(lambda (x) x)"],
    ["nil", "'()"],
  ];

  it.each(TERMLESS)("%s: @values, @entries, and @keys are all empty", async (_label, litExpr) => {
    const env = inferenceEnv.child(`termless-${scratchCounter++}`);
    const keysLen = await execState(`(let ((obj ${litExpr})) (vector-length (@keys obj)))`, { env });
    expect(Number(keysLen.values[0])).toBe(0);
    const valuesLen = await execState(`(let ((obj ${litExpr})) (vector-length (@values obj)))`, { env });
    expect(Number(valuesLen.values[0])).toBe(0);
    const entriesLen = await execState(`(let ((obj ${litExpr})) (vector-length (@entries obj)))`, { env });
    expect(Number(entriesLen.values[0])).toBe(0);
  });
});

describe("@values / @entries — empty object ⇒ empty vector", () => {
  it("(dict) — an empty ADict", async () => {
    const env = envWithObj(await mintDict({}));
    expect(Number((await exec(`(vector-length (@values obj))`, { env }))[0])).toBe(0);
    expect(Number((await exec(`(vector-length (@entries obj))`, { env }))[0])).toBe(0);
  });

  it("a borrowed empty JS object", async () => {
    const env = envWithObj(jsToScheme(CONSTANT_CTX, {}));
    expect(Number((await exec(`(vector-length (@values obj))`, { env }))[0])).toBe(0);
    expect(Number((await exec(`(vector-length (@entries obj))`, { env }))[0])).toBe(0);
  });
});
