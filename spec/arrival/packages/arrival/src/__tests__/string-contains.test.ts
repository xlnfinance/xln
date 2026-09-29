/**
 * `string-contains` / `string-contains?` — the substring-search pair carved into the
 * strings cluster (env/strings.ts). `string-contains` is SRFI-13 (index of the first
 * occurrence, or #f); `string-contains?` is the boolean predicate the same way `member?`
 * pairs with `member`. Both carry the lineage of the strings they searched — a derived
 * "this name contains 'Alloy'" decision over an evidence read must stay grounded
 * ("provenance everything; exclusion is not possible in teleological mode").
 *
 * Previously `string-contains` lived inline in inference-env.ts as a raw `.includes`
 * boolean (lineage erased) and `string-contains?` did not exist at all — an agent
 * reaching for it got `Unbound variable string-contains?`.
 */
import { describe, it, expect } from "vitest";
import type { EnvWithInternals, ResolvingAmbient } from "../env/AmbientRuntime.js";
import { CONSTANT_CTX } from "../run/RunContext.js";
import { execOverFrame, execStateOverFrame } from "../eval/generator-exec.js";
import { inferenceEnv } from "../env/inference-env.js";
import { AString } from "../values/primitives/AString.js";
import { AExact } from "../values/primitives/AExact.js";
import { AValue } from "../values/primitives/AValue.js";
import { requireEagerOracle } from "./_require-eager-oracle.js";

// Q20b: string-contains's provenance assertions run real programs — force the
// oracle ON for this file's lifetime.
requireEagerOracle();

const stamped = (s: string, ...points: number[]) => new AString(s, new Set(points));
const sorted = (set: Set<number>) => [...set].sort((a, b) => a - b);
// Literal-string args carry no provenance, so the result comes back raw (a JS boolean
// or a bare SchemeExact); a provenanced input boxes it. Unwrap either shape.
const js = (x: unknown) => (x instanceof AValue ? x["arrival/toJS"]() : x);

describe("string-contains? — boolean predicate", () => {
  it("true when present, false when absent", async () => {
    const env = inferenceEnv.child("string-contains-pred") as EnvWithInternals<ResolvingAmbient>;
    const [hit] = await execOverFrame('(string-contains? "research-Alloy.docx" "Alloy")', { env });
    const [miss] = await execOverFrame('(string-contains? "spoolsv.exe" "Alloy")', { env });
    expect(js(hit)).toBe(true);
    expect(js(miss)).toBe(false);
  });

  it("carries the provenance of the searched string (grounded decision)", async () => {
    const env = inferenceEnv.child("string-contains-pred-prov") as EnvWithInternals<ResolvingAmbient>;
    env.bind("name", stamped("Alloy.exe", 7));
    // execState (COMPLEX tier): asserts box discipline directly (RULINGS.md R1).
    const [r] = (await execStateOverFrame('(string-contains? name "Alloy")', { env })).values;
    expect(r).toBeInstanceOf(AValue);
    expect(sorted((r as AValue).provenance as Set<number>)).toEqual([7]);
  });
});

describe("string-contains — SRFI-13 index-or-#f", () => {
  it("returns the index of the first occurrence", async () => {
    const env = inferenceEnv.child("string-contains-idx") as EnvWithInternals<ResolvingAmbient>;
    const [r] = (await execStateOverFrame('(string-contains "abcAlloy" "Alloy")', { env })).values;
    expect(r).toBeInstanceOf(AExact);
    expect(js(r)).toBe(3);
  });

  it("returns #f when absent (still truthy-correct: 0 is a real index)", async () => {
    const env = inferenceEnv.child("string-contains-miss") as EnvWithInternals<ResolvingAmbient>;
    const [miss] = await execOverFrame('(string-contains "abc" "Alloy")', { env });
    const [zero] = await execOverFrame('(string-contains "Alloy" "Alloy")', { env });
    expect(js(miss)).toBe(false);
    expect(js(zero)).toBe(0); // index 0 — truthy in Scheme, #f is the only false
  });
});
