// strings-contract-precision.test.ts — RUNTIME proof for the `scheme/strings` capability's
// 2026-07-05 fresh full-file audit: 8 categories of degraded/loose Contract declarations
// tightened to the actual scheme-value domain each op's impl reads. Mirrors the sibling
// audits' established pattern exactly (numeric-contract-precision.test.ts /
// chars-contract-precision.test.ts / contract-precision-fixes.test.ts): a schema's
// PRECISION is only observable at runtime (zod's own `safeParse`) — native ops never run
// this validation during evaluation (bakeNative binds `impl` raw, no decode/encode; see
// _bake.ts), so this is a HARVEST/type-surface proof, not a behavior change. The
// behavior-unchanged proof is the pre-existing r7rs-identity/r7rs-unicode/chibi-r7rs suites
// run byte-identical before/after (see the report).
//
// The 8 fixes (all on `scheme/strings`, src/env/r7rs/strings.ts):
//   1. `string`            — builds a string from chars: z.array(z.unknown()) → z.array(z.schemeChar)
//   2. 10 comparison ops   — string=?/</>/<=/>=  + string-ci variants: z.array(z.unknown()) → z.array(z.schemeString)
//   3. `string-append`     — homogeneous variadic strings: z.array(z.unknown()) → z.array(z.schemeString)
//   4. `string->list`      — output is a proper list of chars: [z.unknown()] → [z.union([z.pair, z.nil])]
//   5. `list->string`      — input walks a Pair (a list of chars): [z.unknown()] → [z.union([z.pair, z.nil])]
//   (former #6 `join` / #7 `concat` removed from scheme/strings — join is scheme/polyglot,
//    concat deleted in favor of string-append; string-join/string-contains live in srfi-13)
//
// (item #8, `split`'s output-side fix, was a stale/misfiled reference in the original audit —
// no `split` symbol is bound in this pack; `string-split` lives in `scheme/srfi-13`.)
//
// #4 is an OUTPUT-side fix — unlike the other 5 (pure input-side, contravariant-safe,
// zero impl signature changes needed), narrowing an OUTPUT schema is a COVARIANT position:
// the impl's own declared return type must narrow to match (a function declared to return
// `unknown` cannot satisfy a Contract whose decoded return is `APair | ANil`) — so it
// also touches strings.ts's impl return-type annotations (still behavior-preserving: bodies
// are byte-for-byte unchanged, only the compile-time annotation tightens). See the report.
//
// Blanket sweep note: a single fixed-size "garbage" probe only exercises ELEMENT precision
// for the genuinely-unbounded array-ish ops (string / comparisons / string-append —
// #1-3); the fixed-arity tuple ops (#4-5) reject an over-length garbage array on
// ARITY alone regardless of element precision, so their fixes are proven by dedicated
// single-element probes instead (a same-arity, wrong-shaped value).

import { describe, expect, it } from "vitest";
import stringsPack from "../strings.js";
import dedent from "dedent";
const norm = (s: string) => s.replace(/\s+/g, " ").trim();
import { signatureOf } from "../../../type-layer/schema-to-ts.js";
import type { AEntity } from "../../../common/symbols/_bake.js";
import { AString } from "../../../values/primitives/AString.js";
import { ACharacter } from "../../../values/primitives/ACharacter.js";
import { APair } from "../../../values/primitives/APair.js";
import { nil } from "../../../values/primitives/ANil.js";
import { CONSTANT_CTX } from "../../../run/RunContext.js";
import { harvestContracts } from "../../../__tests__/_symbols-harvest.js";
import { ANativeProcedure } from "../../../values/primitives/ANativeProcedure.js";

const probeFn = new ANativeProcedure({
  name: "probe-fn",
  arity: { min: 0, max: null },
  contract: undefined,
  impl: () => undefined as never,
});

const symbols = harvestContracts(stringsPack.spec.symbols);

function nativeDef(name: string) {
  const def = symbols[name];
  if (def === undefined) throw new Error(`strings pack: no symbol named ${name}`);
  if (def.kind !== "native") throw new Error(`strings pack: ${name} is not a native def (got ${def.kind})`);
  return def;
}

const ch = (c: string): ACharacter => new ACharacter(c);
const str = (s: string): AString => new AString(s);
const properList = (): APair<any, any> => new APair(ch("a"), nil);

const COMPARISON_OPS = [
  "string=?",
  "string<?",
  "string>?",
  "string<=?",
  "string>=?",
  "string-ci=?",
  "string-ci<?",
  "string-ci>?",
  "string-ci<=?",
  "string-ci>=?",
] as const;

describe("scheme/strings Contract precision — 2026-07-05 audit: 8 fixes on the REAL exported ops", () => {
  it("string: accepts real characters, rejects raw JS strings as elements (was z.array(z.unknown()))", () => {
    const def = nativeDef("string");
    expect(def.in.safeParse([ch("a"), ch("b")]).success).toBe(true);
    expect(def.in.safeParse(["a", "b"]).success).toBe(false);
  });

  it("every comparison op: real strings of any arity parse, a same-length raw-string array no longer does", () => {
    for (const name of COMPARISON_OPS) {
      const def = nativeDef(name);
      expect(def.in.safeParse([]).success, `${name}: empty array (0-arity trivial true)`).toBe(true);
      expect(def.in.safeParse([str("x")]).success, `${name}: single real string`).toBe(true);
      expect(def.in.safeParse([str("x"), str("y")]).success, `${name}: real string array`).toBe(true);
      expect(def.in.safeParse(["x", "y"]).success, `${name}: raw string array — was true, now false`).toBe(false);
    }
  });

  it("string-append: accepts real strings, rejects raw JS strings as elements (was z.array(z.unknown()))", () => {
    const def = nativeDef("string-append");
    expect(def.in.safeParse([str("a"), str("b")]).success).toBe(true);
    expect(def.in.safeParse(["a", "b"]).success).toBe(false);
  });

  it("string->list: output must be a proper list (Pair|Nil) — a raw string no longer satisfies it (was [z.unknown()])", () => {
    const def = nativeDef("string->list");
    expect(def.out.safeParse([properList()]).success).toBe(true);
    expect(def.out.safeParse([nil]).success).toBe(true);
    expect(def.out.safeParse(["not-a-list"]).success).toBe(false);
  });

  it("list->string: input must be a proper list (Pair|Nil) — a raw string no longer satisfies it (was [z.unknown()])", () => {
    const def = nativeDef("list->string");
    expect(def.in.safeParse([properList()]).success).toBe(true);
    expect(def.in.safeParse([nil]).success).toBe(true);
    expect(def.in.safeParse(["not-a-list"]).success).toBe(false);
  });

  // NOTE: no symbol named `split` is bound in this pack. `string-split` lives in scheme/srfi-13.

  it("blanket sweep: no native op in the pack accepts an arbitrary-shape raw-JS-garbage array on .in (mirrors numeric-/chars-contract-precision.test.ts)", () => {
    const garbage = ["not-a-value", 123, null, {}];
    const stragglers: string[] = [];
    for (const [name, def] of Object.entries(symbols)) {
      if (def.kind !== "native") continue;
      if (def.in.safeParse(garbage).success) stragglers.push(name);
    }
    expect(stragglers).toEqual([]);
  });

  it("sanity: the pack exports exactly 28 symbols — the scope this fix must cover", () => {
    expect(Object.keys(symbols)).toHaveLength(28);
  });

  it("regression pin: string-map/string-for-each's earlier inputRest fix is untouched by this round", () => {
    const mapDef = nativeDef("string-map");
    expect(mapDef.in.safeParse([probeFn, str("abc")]).success).toBe(true);
    expect(mapDef.in.safeParse([probeFn, "raw-js-string"]).success).toBe(false);
    // for-each shares the same rest precision (was only asserted on map in the central
    // contract-precision-fixes file — ownership moved here per redundancy receipts).
    const eachDef = nativeDef("string-for-each");
    expect(eachDef.in.safeParse([probeFn, str("abc")]).success).toBe(true);
    expect(eachDef.in.safeParse([probeFn, "raw-js-string"]).success).toBe(false);
  });
});

describe("scheme/strings Contract.type overrides — the harvest signature for the two HOFs whose z.custom callable HEAD is UNREPRESENTABLE (printer throws, degrading the whole signature to `(...args: unknown[]) => unknown` and losing the string rest + the string/void return)", () => {
  // string-map/string-for-each declare `input: [z.custom<callable>()], inputRest: z.schemeString`.
  // The callable head is unrepresentable to the harvest printer, so the WHOLE signature degrades
  // to the catch-all — throwing away the fn-first shape, the `string[]` rest (harvested straight
  // from z.schemeString), and the string / void return. `Contract.type` restores the real shape
  // (same convention as the sibling srfi curry/find overrides: callable → `(...args: unknown[]) =>
  // unknown`, a void HOF return → bare `void` as in env/core/core.ts's own hand-written type).
  it("string-map: proc-first over a string rest → string", () => {
    expect(norm(signatureOf(nativeDef("string-map")))).toBe(
      norm(dedent`
        {
          (f: (c: string) => string, s: string): string;
          (f: (...chars: string[]) => string, ...strings: string[]): string;
        }
      `),
    );
  });
  it("string-for-each: proc-first over a string rest, for effect → void", () => {
    expect(norm(signatureOf(nativeDef("string-for-each")))).toBe(
      norm(dedent`
        {
          (f: (c: string) => unknown, s: string): void;
          (f: (...chars: string[]) => unknown, ...strings: string[]): void;
        }
      `),
    );
  });
});
