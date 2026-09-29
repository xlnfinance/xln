// lists-contract-precision.test.ts — RUNTIME proof that the scheme/lists precision fixes
// actually land on the REAL exported ops — not a synthetic mirror (see the sibling
// `lists.test-d.ts` for the type-level mechanism proofs, which must stay synthetic because
// `NativeSymbolDef.in`/`.out` erase `I`/`O` on any real export — see symbol.test-d.ts's
// "apply's own declared shape" note). Mirrors numeric-contract-precision.test.ts /
// bytevectors-contract-precision.test.ts's established pattern: a schema's PRECISION is only
// observable at runtime (zod's own `safeParse`) — native/sequence ops never run this
// validation during evaluation (see lists.ts's own module doc comment), so this is a
// HARVEST/type-surface proof, not a behavior change. The behavior-unchanged proof is the
// full existing suite (including src/__tests__/cyclic-list-ops.test.ts, clone-identity.test.ts,
// r7rs-identity.test.ts, which exercise these ops end-to-end through the interpreter) run
// byte-identical before/after (see the report).
//
// ★ CALIBRATION NOTE (same one contract-precision-fixes.test.ts's header flags): `z.schemeValue`
// (`z.custom<SchemeValue>()`) carries NO refinement — it accepts literally anything at
// runtime, byte-identical to `z.unknown()`. So a `z.unknown() → z.schemeValue` fix is a STATIC-ONLY
// precision improvement (the `.d.ts` harvest surface), with NO observable `.safeParse`
// difference — for THOSE fixes (cons, map, list-tail/list-ref/list-set!'s obj, memq-family's
// output-or-false, member/assoc's obj+compare) the real proof lives in the type-level
// `lists.test-d.ts` file, and this file only documents (not "proves a reject") the
// still-permissive runtime behavior where relevant. This file's assertions focus on the
// SUBSET of fixes that gained a genuine zod REFINEMENT (instanceof / Array.isArray /
// fixed-arity) and therefore reject a wrongly-shaped value the old `z.unknown()` accepted:
// make-list's output (now z.pair|z.nil), and list->array's
// output (now z.array(z.schemeValue) — Array.isArray refinement).
import { describe, expect, it } from "vitest";
import listsPack from "../lists.js";
import dedent from "dedent";
const norm = (s: string) => s.replace(/\s+/g, " ").trim();
import { signatureOf } from "../../../type-layer/schema-to-ts.js";
import type { AEntity } from "../../../common/symbols/_bake.js";
import { APair } from "../../../values/primitives/APair.js";
import { ANil, nil } from "../../../values/primitives/ANil.js";
import { AExact } from "../../../values/primitives/AExact.js";
import { AString } from "../../../values/primitives/AString.js";
import { CONSTANT_CTX } from "../../../run/RunContext.js";
import { schemeFalse } from "../../../values/primitives/ABool.js";
import type { SchemeValue } from "../../../values/types.js";
import { harvestContracts } from "../../../__tests__/_symbols-harvest.js";
import { ANativeProcedure } from "../../../values/primitives/ANativeProcedure.js";
import { theVoid } from "../../../values/primitives/AVoid.js";

const symbols = harvestContracts(listsPack.spec.symbols);

function nativeDef(name: string) {
  const def = symbols[name];
  if (def === undefined) throw new Error(`lists pack: no symbol named ${name}`);
  if (def.kind !== "native") throw new Error(`lists pack: ${name} is not a native def (got ${def.kind})`);
  return def;
}

function sequenceDef(name: string) {
  const def = symbols[name];
  if (def === undefined) throw new Error(`lists pack: no symbol named ${name}`);
  if (def.kind !== "sequence") throw new Error(`lists pack: ${name} is not a sequence def (got ${def.kind})`);
  return def;
}

const exact = (n: number): AExact => new AExact(n);
const str = (s: string): AString => new AString(s);
// Adversarial fixture: `properList` deliberately builds pair-chains over non-SchemeValue
// elements too (raw JS numbers/functions — see call sites below) to probe zod schema
// REJECTION under this file's own precision fixes. `fromArray`'s `T extends SchemeValue`
// constraint targets genuine callers; construction itself never dereferences element
// shape, only the zod schemas under test do — the cast documents that mismatch.
const properList = (...items: unknown[]) => APair.fromArray(CONSTANT_CTX, items as SchemeValue[]);
// W8: z.lambda admits ACallable only — bare host fns are refused.
const fn = new ANativeProcedure({
  name: "fn",
  arity: { min: 0, max: null },
  contract: undefined,
  impl: () => theVoid,
});

describe("scheme/lists Contract precision — genuinely REFINED schemas reject wrongly-shaped values (were z.unknown(), now zod-validated)", () => {
  it("make-list: output is now z.union([z.pair, z.nil]) (a proper list) — a raw non-list value used to slip through the old z.unknown()", () => {
    const def = nativeDef("make-list");
    expect(def.out.safeParse([nil]).success).toBe(true);
    // z.pair is cons(value, value): validates car/cdr via z.schemeValue. Boxed
    // `schemeFalse` is the honest scheme value; a raw JS `false` does not parse.
    expect(def.out.safeParse([properList(schemeFalse, schemeFalse)]).success).toBe(true);
    expect(def.out.safeParse(["not-a-list"]).success).toBe(false);
    expect(def.out.safeParse([42]).success).toBe(false);
    // fill (2nd input) stays permissive (z.schemeValue — genuinely "any scheme value", no
    // narrower domain makes sense for a fill value): still accepts anything.
    expect(def.in.safeParse([exact(3)]).success).toBe(true); // fill omitted (optional)
    expect(def.in.safeParse([exact(3), str("x")]).success).toBe(true);
    expect(def.in.safeParse(["not-a-scheme-number"]).success).toBe(false); // k must be schemeNumber
  });

  // nth moved to scheme/polyglot-clojure (Clojure index-first); contract pins live there.

  it("length: output narrows z.schemeValue → z.schemeNumber — the HalfBaked carrier return died with AHalfBaked itself, so length always returns a settled AExact/AInexact", () => {
    const def = nativeDef("length");
    expect(def.in.safeParse([properList(1, 2)]).success).toBe(true);
    expect(def.out.safeParse([exact(2)]).success).toBe(true);
    expect(def.out.safeParse(["not-a-number"]).success).toBe(false);
    expect(def.out.safeParse([{ garbage: true }]).success).toBe(false);
  });
});

describe("scheme/lists Contract precision — STATIC-only fixes (documented, not runtime-provable — see lists.test-d.ts for the real proof)", () => {
  // z.schemeValue (isSchemeValue) carries a real refinement — `instanceof AValue ||
  // typeof === "function"` — it is not z.unknown()'s alias. A raw JS string/number
  // fails it. The static decoded type is SchemeValue; the runtime domain is any
  // boxed scheme value, not any raw value.
  it("cons: car/cdr accept any BOXED scheme value; a raw non-scheme value is genuinely rejected (z.schemeValue = isSchemeValue, a real refinement) — the fix is the STATIC decoded type (unknown → SchemeValue), not a runtime behavior change", () => {
    const def = nativeDef("cons");
    expect(def.in.safeParse([exact(1), exact(2)]).success).toBe(true);
    expect(def.in.safeParse(["raw-js-string", 123]).success).toBe(false); // genuinely rejected — z.schemeValue refines
    expect(def.out.safeParse([new APair(exact(1), nil)]).success).toBe(true);
  });

  it("map (sequence): rest/output are z.schemeValue-flavored (no refinement) — still permissive at runtime for the rest+output; the fix is the head/rest SPLIT + precise decoded types (see lists.test-d.ts). The HEAD did later gain a real z.lambda refinement (the uniform-vocabulary migration), so — unlike when this test was authored — it now DOES create a genuine arity floor.", () => {
    const def = sequenceDef("map");
    expect(def.in.safeParse([fn, properList(1, 2, 3)]).success).toBe(true);
    expect(def.in.safeParse([fn]).success).toBe(true); // 0 further lists — still legal (map over one term)
    // z.lambda's predicate is ACallable-only — a MISSING head position decodes to
    // `undefined`, which fails that check, so an empty array is genuinely rejected.
    expect(def.in.safeParse([]).success).toBe(false);
  });

  it("list-tail / list-ref: output is z.schemeValue (no refinement) — a sublist/element can legitimately be ANY scheme value (an improper-list tail, or a car that's a bare number), so z.schemeValue (not a pair|nil union) is the honest ceiling", () => {
    const tailDef = nativeDef("list-tail");
    expect(tailDef.out.safeParse([properList(1, 2)]).success).toBe(true);
    expect(tailDef.out.safeParse([exact(42)]).success).toBe(true); // an improper-list tail is a valid result

    const refDef = nativeDef("list-ref");
    expect(refDef.out.safeParse([exact(42)]).success).toBe(true); // an element is any scheme value
  });

  it("list-set!: doored this session (mutation violates value provenance) — no longer a native def to probe", () => {
    expect(symbols["list-set!"].kind).toBe("door");
  });

  it("list-copy: input/output already z.schemeValue both sides — confirmed already precise, no change needed (output can legitimately be a non-list improper tail)", () => {
    const def = nativeDef("list-copy");
    expect(def.in.safeParse([properList(1, 2)]).success).toBe(true);
    expect(def.out.safeParse([properList(1, 2)]).success).toBe(true);
  });

  // memq/assq's obj is z.schemeValue (boxed scheme value), not host-blind.
  // eq?'s raw `===` still works at runtime against an unboxed operand (native
  // ops never validate); the harvest schema narrows to boxed scheme values.
  it("memq/assq: the search key (obj) is z.schemeValue — a raw non-scheme value is genuinely rejected by the schema (though eq?'s runtime `===` never actually checks it)", () => {
    expect(nativeDef("memq").in.safeParse([exact(1), properList(1, 2)]).success).toBe(true);
    expect(nativeDef("memq").in.safeParse(["anything-at-all", properList(1, 2)]).success).toBe(false);
    expect(nativeDef("assq").in.safeParse([exact(1), properList(properList(1, 2))]).success).toBe(true);
    expect(nativeDef("assq").in.safeParse(["anything-at-all", properList(properList(1, 2))]).success).toBe(false);
  });

  // `[z.schemeValue, z.booleanFalse]` admits no unboxed scalar: `isSchemeValue` is
  // `instanceof AValue || typeof === "function"`, and z.booleanFalse requires a boxed
  // ABool. zod `safeParse` rejection is the door.
  it("memv/assq/assv/member/assoc: output is z.union([z.schemeValue, z.booleanFalse]) — a genuine strict door: a real match (boxed) or the boxed #f sentinel, nothing raw admitted by either arm", () => {
    for (const name of ["memv", "assq", "assv", "member", "assoc"]) {
      const def = nativeDef(name);
      expect(def.out.safeParse([properList(1, 2)]).success).toBe(true);
      expect(def.out.safeParse([schemeFalse]).success).toBe(true);
      // Neither arm admits a raw scalar: z.booleanFalse requires a boxed ABool, and
      // z.schemeValue's isSchemeValue requires instanceof AValue (or a callable) — a bare
      // JS `false`/string satisfies neither.
      expect(def.out.safeParse([false]).success).toBe(false);
      expect(def.out.safeParse(["anything"]).success).toBe(false);
    }
  });

  it("memq: output is z.union([z.pair, z.booleanFalse]) — tighter than its 5 siblings above (its success path always returns the live APair cell it matched on, never a bare value), so it genuinely rejects both a raw JS `false` and an arbitrary non-pair value", () => {
    const def = nativeDef("memq");
    expect(def.out.safeParse([properList(1, 2)]).success).toBe(true);
    expect(def.out.safeParse([schemeFalse]).success).toBe(true);
    expect(def.out.safeParse([false]).success).toBe(false); // no z.schemeValue arm here — genuinely rejected
    expect(def.out.safeParse(["anything"]).success).toBe(false);
  });

  it("member/assoc: obj accepts any scheme value (was z.unknown(), now z.schemeValue — static-only); compare predicate's return type is now `unknown` not `boolean` (matches the file's is_false-guarded actual usage, and srfi-1.ts filter's established convention)", () => {
    for (const name of ["member", "assoc"]) {
      const def = nativeDef(name);
      expect(def.in.safeParse([exact(1), properList(1, 2)]).success).toBe(true);
      expect(def.in.safeParse([exact(1), properList(1, 2), fn]).success).toBe(true);
    }
  });
});

describe("scheme/lists Contract precision — regression guard: unaffected/already-precise siblings stay untouched", () => {
  it("list: already z.array(z.schemeValue)/[z.schemeValue] — untouched by this pass (already precise before this audit)", () => {
    const def = nativeDef("list");
    expect(def.in.safeParse([exact(1), exact(2), exact(3)]).success).toBe(true);
    expect(def.in.safeParse([]).success).toBe(true); // 0-arg list is legal
  });

  it("append/reverse: untouched — already at their honest precision ceiling (append/list are legitimately fully-variadic-over-SchemeValue; reverse's own impl has NO array branch — pair|nil only)", () => {
    // NOTE: no bound scheme symbol named `clone` exists in this pack — `.clone()` is an
    // internal APair JS method, not an exported op (`list-copy`, tested separately above, is
    // the exported R7RS freshness-copy operation this describe block's title once conflated it with).
    expect(nativeDef("append").in.safeParse([properList(1), properList(2)]).success).toBe(true);
    // reverse's impl only handles ANil/APair (a final `else` throws) — a raw array is genuinely
    // rejected (array->list, the array-or-pair polymorphism this once contrasted with, is
    // dissolved — no longer bound in this pack).
    expect(nativeDef("reverse").in.safeParse([[1, 2, 3]]).success).toBe(false);
    expect(nativeDef("reverse").in.safeParse([properList(1, 2, 3)]).success).toBe(true);
  });

  it("apply / for-each: already migrated to inputRest this session — untouched, glanced at only as the migration's own reference examples", () => {
    const applyDef = nativeDef("apply");
    // apply's HEAD is now z.lambda (a real callable predicate, added by the uniform-vocabulary
    // migration) — three bare AExact values have no callable head, so this now genuinely rejects.
    expect(applyDef.in.safeParse([exact(1), exact(2), exact(3)]).success).toBe(false);
    expect(applyDef.in.safeParse([fn, exact(1), properList(2, 3)]).success).toBe(true);
    const forEachDef = nativeDef("for-each");
    expect(forEachDef.in.safeParse([fn, properList(1, 2)]).success).toBe(true);
    expect(forEachDef.in.safeParse([fn, "not-a-list"]).success).toBe(false); // pre-existing fix, unaffected
  });
});

describe("scheme/lists Contract precision — blanket sweep: genuinely-variadic-and-still-unconstrained ops (regression guard)", () => {
  // z.schemeValue is a real refinement (`instanceof AValue || typeof === "function"`),
  // not a permissive no-op — even `list`/`append` reject raw JS garbage. Empty
  // stragglers is the honest bar: no op is both-sides unconstrained.
  it("EVERY native/sequence op's Contract is precise — no straggler with BOTH sides still fully unconstrained against raw JS garbage (z.schemeValue's isSchemeValue refinement is real, not a permissive no-op)", () => {
    const stragglers: string[] = [];
    for (const [name, def] of Object.entries(symbols)) {
      if (def.kind !== "native" && def.kind !== "sequence") continue;
      const inputStillDegraded =
        def.in.safeParse([]).success && def.in.safeParse(["anything", 123, null, {}, [1, 2, 3]]).success;
      const outputStillDegraded =
        def.out.safeParse(["anything"]).success && def.out.safeParse([{ garbage: true }]).success;
      if (inputStillDegraded && outputStillDegraded) stragglers.push(name);
    }
    expect(stragglers.sort()).toEqual([]);
  });

  it("sanity: the pack exports exactly 22 symbols (the scope this review must cover)", () => {
    expect(Object.keys(symbols)).toHaveLength(22);
  });
});

describe('scheme/lists Contract.type overrides — the harvest signature (signatureOf) for the ops whose z.custom callable arg is UNREPRESENTABLE to the printer (it throws `Schemas of type "custom" cannot be represented`, degrading the WHOLE signature to the catch-all `(...args: unknown[]) => unknown`)', () => {
  // These ops carry a z.custom<callable>() in their contract (map/for-each's fn head,
  // member/assoc's optional compare). The printer degrades each to the bare
  // `(...args: unknown[]) => unknown`, throwing away the fn-first structure, the list
  // receiver type, and the void/`unknown | false` return. `Contract.type` author-asserts
  // the real shape — same trust model + same this-session convention as the sibling
  // srfi-1 `find` / srfi-95 `sort` overrides (a callable renders as
  // `(...args: unknown[]) => unknown`; a representation-AGNOSTIC receiver stays
  // `unknown` — map dispatches to Pair/Nil/Vector terms, so narrowing to a List would be false,
  // exactly sort's own documented reasoning; a genuinely list-only receiver is `Cons<unknown> |
  // null`, the same image the file's own non-degraded list ops harvest as).
  it("map (sequence): List|vector dual generics over element types (not R[]/unknown)", () => {
    expect(norm(signatureOf(sequenceDef("map")))).toBe(
      norm(dedent`
        {
          <T, B>(f: (x: T) => B, xs: List<T>): List<B>;
          <T, B>(f: (x: T) => B, xs: readonly T[]): readonly B[];
          <A, B, R>(f: (a: A, b: B) => R, as: List<A>, bs: List<B>): List<R>;
          <A, B, R>(f: (a: A, b: B) => R, as: readonly A[], bs: readonly B[]): readonly R[];
          <A, B, C, R>(f: (a: A, b: B, c: C) => R, as: List<A>, bs: List<B>, cs: List<C>): List<R>;
          <A, B, C, R>(f: (a: A, b: B, c: C) => R, as: readonly A[], bs: readonly B[], cs: readonly C[]): readonly R[];
        }
      `),
    );
  });
  it("for-each: list dual generics → void", () => {
    expect(norm(signatureOf(nativeDef("for-each")))).toBe(
      norm(dedent`
        {
          <T>(f: (x: T) => unknown, xs: List<T>): void;
          <A, B>(f: (a: A, b: B) => unknown, as: List<A>, bs: List<B>): void;
          <A, B, C>(f: (a: A, b: B, c: C) => unknown, as: List<A>, bs: List<B>, cs: List<C>): void;
        }
      `),
    );
  });
  it("member: generic List search with optional compare", () => {
    expect(norm(signatureOf(nativeDef("member")))).toBe(
      norm(dedent`
        {
          <T>(obj: T, list: List<T>): List<T> | false;
          <T>(obj: T, list: List<T>, compare: (a: T, b: T) => unknown): List<T> | false;
        }
      `),
    );
  });
  it("assoc: generic alist search with optional compare", () => {
    expect(norm(signatureOf(nativeDef("assoc")))).toBe(
      norm(dedent`
        {
          <K, V>(obj: K, alist: List<[K, V]>): [K, V] | false;
          <K, V>(obj: K, alist: List<[K, V]>, compare: (a: K, b: K) => unknown): [K, V] | false;
        }
      `),
    );
  });
});
