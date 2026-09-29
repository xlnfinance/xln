// symbol — TYPE-LEVEL PROOFS for the `arrival.symbol*` contract machinery.
//
// The load-bearing inference of the symbol API: a contract's zod tuple drives BOTH the
// decoded impl-arg types (`DecodedArgs`) and the decoded return type (`DecodedReturn`), so
// a wrong-typed impl is a COMPILE error. These assertions used to live inline in
// `src/common/symbol.ts` as a `type _Assert = …` block, because both package tsconfigs
// EXCLUDE the test dirs (`src/**/*.test.ts`, `src/__*__/**/*`) — so a plain `*.test.ts`
// would never be typechecked. This file is a `*.test-d.ts` run under `vitest --typecheck`
// (see `vitest.typecheck.config.ts` + `tsconfig.typecheck.json`, which un-exclude it), so
// the proofs now fail CI as a real test on any type regression instead of riding the build.
//
// POSITIVE proofs use `expectTypeOf().toEqualTypeOf()`. NEGATIVE proofs (a wrong-typed impl
// must NOT compile) use `@ts-expect-error` over the live constructors — vitest's typecheck
// mode honors `@ts-expect-error`, so each marked line reds if it ever starts compiling.

import { describe, expectTypeOf, test } from "vitest";
import * as z from "../common/scheme-zod/index.js";
import type { AEntity } from "../common/symbols/_bake.js";
import { symbol } from "../symbol/index.js";
import { type NativeSymbolDef } from "../values/primitives/ANativeProcedure.js";
import {
  type DecodedArgs,
  type DecodedArgsWithRest,
  type DecodedReturn,
  type SpecInfer,
} from "../common/symbols/_bake.js";
import { type SlotAdopter, buildSlotAdopter } from "../membrane/adopt-spine.js";
import type { APair } from "../values/primitives/APair.js";
import type { AString } from "../values/primitives/AString.js";
import type { ANil } from "../values/primitives/ANil.js";
import type { ACallable } from "../values/primitives/ACallable.js";
import type { AList, AListAlike, SchemeValue } from "../values/types.js";

type PairScheme = APair<SchemeValue, SchemeValue>;
type ListOrNilScheme = PairScheme | ANil;

describe("SpecInfer — the shared VectorSpec → z.output traversal DecodedArgs/DecodedReturn build on", () => {
  test("tuple spec: element-wise z.output, as a mutable tuple", () => {
    // z.pair is a real codec (cons) — scheme face is APair, js face is a tuple.
    expectTypeOf<SpecInfer<[typeof z.pair], "scheme">>().toEqualTypeOf<[PairScheme]>();
    expectTypeOf<SpecInfer<[typeof z.pair, typeof z.string], "scheme">>().toEqualTypeOf<[PairScheme, AString]>();
  });

  test("single-schema spec: bare z.output, no tuple wrapping", () => {
    expectTypeOf<SpecInfer<typeof z.string>>().toEqualTypeOf<string>();
    expectTypeOf<SpecInfer<typeof z.pair, "scheme">>().toEqualTypeOf<PairScheme>();
  });

  test("a 1-tuple spec stays a 1-tuple (unlike DecodedArgs, SpecInfer never wraps/collapses — that's each caller's own job)", () => {
    expectTypeOf<SpecInfer<[typeof z.number]>>().toEqualTypeOf<[number]>();
  });

  test("variadic (z.array) single-schema spec: the element-array bare, matching z.output", () => {
    expectTypeOf<SpecInfer<ReturnType<typeof z.array<typeof z.number>>>>().toEqualTypeOf<number[]>();
  });
});

describe("symbol contract — decoded arg/return inference", () => {
  test("native: a scheme-face tuple infers the impl arg as the SCHEME TERM", () => {
    // `z.pair` is a real codec (cons); native reads the SCHEME face (z.input) → APair.
    expectTypeOf<DecodedArgs<[typeof z.pair], "scheme">>().toEqualTypeOf<[PairScheme]>();
  });

  test("rosetta: a codec tuple infers the impl arg as the DECODED JS value", () => {
    // `z.string` is a codec (`AString` ↔ `string`); rosetta impls work in JS-land.
    expectTypeOf<DecodedArgs<[typeof z.string]>>().toEqualTypeOf<[string]>();
  });

  test("the number family decodes to the codec's declared JS type", () => {
    expectTypeOf<DecodedArgs<[typeof z.number]>>().toEqualTypeOf<[number]>();
    expectTypeOf<DecodedArgs<[typeof z.bigint]>>().toEqualTypeOf<[bigint]>();
  });

  test("a 1-tuple output collapses to a SINGLE decoded return", () => {
    // The 1-tuple-collapse: `[schema]` output → the impl returns the bare value (we wrap it
    // as a 1-element values-list), NOT a 1-tuple.
    expectTypeOf<DecodedReturn<[typeof z.number]>>().toEqualTypeOf<number>();
  });

  test("variadic: an array-ish (z.array) input → the element-array as the impl's rest params", () => {
    expectTypeOf<DecodedArgs<ReturnType<typeof z.array<typeof z.number>>>>().toEqualTypeOf<number[]>();
  });
});

describe("symbol contract — wrong-typed impls must NOT compile", () => {
  // Guarded by a `false` const so the constructors never run — these are type-only proofs.
  // Each `@ts-expect-error` asserts the line BELOW it does not typecheck; the generic
  // constructor inference (contract → decoded impl signature) is the proof under test.
  const RUN = false as boolean;

  test("native impl receives a Pair (identity), not a string", () => {
    if (RUN) {
      symbol.native`p: proof`(
        { input: [z.pair], output: [z.pair] },
        // @ts-expect-error — arg is Pair, annotating it string is wrong
        (p: string) => p as unknown as APair,
      );
    }
    expectTypeOf<true>().toEqualTypeOf<true>();
  });

  test("rosetta impl receives a decoded string, not a Pair", () => {
    if (RUN) {
      symbol.rosetta`r: proof`(
        { input: [z.string], output: [z.number] },
        // @ts-expect-error — arg is string, annotating it Pair is wrong
        (s: APair) => 1,
      );
    }
    expectTypeOf<true>().toEqualTypeOf<true>();
  });

  test("rosetta return: the output codec wants number; returning the string arg is wrong", () => {
    if (RUN) {
      symbol.rosetta`rr: proof`(
        { input: [z.string], output: [z.number] },
        // @ts-expect-error — return must be number, not string
        (s) => s,
      );
    }
    expectTypeOf<true>().toEqualTypeOf<true>();
  });
});

describe("buildSlotAdopter — scheme-face tuple after adoption", () => {
  test("listAlike slot: raw SchemeValue[] in, AListAlike tuple out", () => {
    expectTypeOf(buildSlotAdopter([z.listAlike])).toEqualTypeOf<
      SlotAdopter<readonly [typeof z.listAlike]> | undefined
    >();
    expectTypeOf<ReturnType<SlotAdopter<[typeof z.listAlike]>>>().toEqualTypeOf<[AListAlike]>();
  });

  test("listAlike head + schemeValue rest: tail is SchemeValue[]", () => {
    expectTypeOf<ReturnType<SlotAdopter<[typeof z.listAlike], typeof z.schemeValue>>>().toEqualTypeOf<
      [AListAlike, ...SchemeValue[]]
    >();
  });
});

describe("symbol contract — inputRest: a fixed head + a separately-typed variadic tail", () => {
  test("mechanism: head and rest genuinely differ in type — proves the split is real, not coincidental", () => {
    expectTypeOf<DecodedArgsWithRest<[typeof z.string], typeof z.number>>().toEqualTypeOf<[string, ...number[]]>();
  });

  test("native-identity flavored: a Pair head + a SchemeValue (z.schemeValue) rest", () => {
    // "scheme" face — z.pair scheme face is APair; rest is SchemeValue.
    expectTypeOf<DecodedArgsWithRest<[typeof z.pair], typeof z.schemeValue, "scheme">>().toEqualTypeOf<
      [PairScheme, ...SchemeValue[]]
    >();
  });

  test("no rest (Rest defaults to undefined) is BYTE-IDENTICAL to today's DecodedArgs<I> — the additive guarantee", () => {
    expectTypeOf<DecodedArgsWithRest<[typeof z.pair], undefined, "scheme">>().toEqualTypeOf<
      DecodedArgs<[typeof z.pair], "scheme">
    >();
    expectTypeOf<DecodedArgsWithRest<[typeof z.pair], undefined, "scheme">>().toEqualTypeOf<[PairScheme]>();
    expectTypeOf<DecodedArgsWithRest<[typeof z.string]>>().toEqualTypeOf<DecodedArgs<[typeof z.string]>>();
    expectTypeOf<DecodedArgsWithRest<[typeof z.string]>>().toEqualTypeOf<[string]>();
  });

  test("apply's own declared shape: a SchemeValue head + a SchemeValue... tail", () => {
    // Mirrors apply's real migrated contract exactly: { input: [z.schemeValue], inputRest: z.schemeValue, output: [z.schemeValue] }.
    // (Native SymbolDef erases the concrete Contract type on its return, so the real bound `apply`
    // export can't be re-inspected at the type level — this synthetic contract IS apply's declared
    // shape, proving the mechanism computes the right decoded-args type for it.)
    expectTypeOf<DecodedArgsWithRest<[typeof z.schemeValue], typeof z.schemeValue>>().toEqualTypeOf<
      [SchemeValue, ...SchemeValue[]]
    >();
  });

  test("wrong-typed rest param must NOT compile", () => {
    const RUN = false as boolean;
    if (RUN) {
      symbol.rosetta`headtail: proof`(
        { input: [z.string], inputRest: z.number, output: [z.string] },
        // @ts-expect-error — rest args decode via z.number (JS number), annotating them string is wrong
        (head: string, ...rest: string[]) => head,
      );
    }
    expectTypeOf<true>().toEqualTypeOf<true>();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2026-07-05 audit: six declaration-precision fixes (for-each / string-map /
// string-for-each / filter / typecheck / find). Each proof below mirrors the REAL migrated
// contract shape synthetically (NativeSymbolDef/SequenceSymbolDef erase `I`/`O` on any
// real export — see the "apply's own declared shape" note above), proving the
// mechanism computes the right decoded type for the actual declaration each op now uses.
//
// CONVENTION NOTE: for-each/string-map/string-for-each/filter's proc/pred HEAD position
// uses the callable-schema style `z.custom<(...args: unknown[]) => T>()` — the
// established convention for "this position is invoked as a JS-callable" (vector-map's
// proc, vector-for-each's proc, curry's fn, call-with-values's producer/consumer,
// member/assoc's compare predicate all already use this shape: 7 call sites across 4
// files). `apply`'s plain `z.schemeValue` head is the outlier — its own doc comment frames
// that choice as "both happen to be z.schemeValue here" (illustrating the head/rest SPLIT,
// not a deliberate "callables are z.schemeValue" rule), and apply's body does its own runtime
// `typecheck(...,"function")` + narrowing rather than leaning on the schema for shape.
// ─────────────────────────────────────────────────────────────────────────────
describe("symbol contract — 2026-07-05 audit: for-each / string-map / string-for-each head+rest precision", () => {
  const forEachHead = z.lambda;
  const listRest = z.union([z.pair, z.nil]);

  test("NEW for-each shape: [callable, ...list[]] — a Pair|Nil rest, not a flat array", () => {
    // Mirrors for-each's real migrated contract: { input: [z.custom<...>()], inputRest: z.union([z.pair, z.nil]), output: [z.undefinedResult] }.
    // Both members of the rest union are real codecs now: nil's JS face is null (not ANil),
    // and pair's JS face is [SchemeValue, SchemeValue] (cons(value,value), not bare APair) —
    // AList (APair|ANil) is the SCHEME face, this is the JS one.
    // Head return is `unknown`, not `SchemeValue` — forEachHead is z.lambda, whose declared
    // return type is (...args: unknown[]) => unknown (matches the sibling string-map/
    // string-for-each test below, same z.lambda). Pre-existing mismatch here, unrelated to nil.
    // z.lambda → ACallable (W8: scheme callables only, not bare host fns).
    // listRest JS face: pair→tuple, nil→null.
    expectTypeOf<DecodedArgsWithRest<[typeof forEachHead], typeof listRest>>().toEqualTypeOf<
      [ACallable, ...([SchemeValue, SchemeValue] | null)[]]
    >();
  });

  const stringHOFHead = z.lambda;

  test("NEW string-map/string-for-each shape: [callable, ...string[]], not flat unknown[]", () => {
    // Default (js) face of z.string is bare `string`; z.lambda → ACallable (W8).
    // (Scheme-face rest would be AString[] — native contour; these HOFs use the js face
    // when authored as rosetta-style synthetic mirrors in this proof.)
    expectTypeOf<DecodedArgsWithRest<[typeof stringHOFHead], typeof z.string>>().toEqualTypeOf<
      [ACallable, ...string[]]
    >();
  });
});

describe("symbol contract — 2026-07-05 audit: filter's contract narrows to a fixed 2-tuple", () => {
  test("NEW shape: a bare 2-element array literal decodes to a FIXED [pred, seq] tuple", () => {
    // Mirrors filter's real migrated contract: { input: [z.lambda, z.schemeValue], ... }.
    const predSchema = z.lambda;
    expectTypeOf<DecodedArgs<[typeof predSchema, typeof z.schemeValue]>>().toEqualTypeOf<[ACallable, SchemeValue]>();
  });
});

describe("symbol contract — 2026-07-05 audit: find's predicate + return precision (srfi-1.ts)", () => {
  // find's list arg was ALREADY precise (z.union([z.pair, z.nil]), matching its own
  // typecheck("find", list, ["pair","nil"]) domain) — untouched here. The two imprecise
  // slots are the predicate (arg1) and the return.
  const listOrNil = z.union([z.pair, z.nil]);

  test("NEW shape: predicate slot is a callable schema — the established z.lambda convention (filter/vector-map/vector-for-each/curry/member's compare)", () => {
    // Default (js) face of the union: pair→tuple, nil→null. z.lambda → ACallable.
    expectTypeOf<DecodedArgs<[typeof z.lambda, typeof listOrNil]>>().toEqualTypeOf<
      [ACallable, [SchemeValue, SchemeValue] | null]
    >();
  });

  test("NEW output z.schemeValue collapses to SchemeValue — mirrors vectors.ts's vector-ref/vector->list z.unknown()→z.schemeValue fix (vectors.test-d.ts)", () => {
    expectTypeOf<DecodedReturn<[typeof z.schemeValue]>>().toEqualTypeOf<SchemeValue>();
  });

  test("wrong-typed impl: a bare string return (not a member of the SchemeValue union) must NOT satisfy the fixed contract", () => {
    const RUN = false as boolean;
    if (RUN) {
      symbol.native`find: proof`(
        { input: [z.lambda, listOrNil], output: [z.schemeValue] },
        // @ts-expect-error — output decodes to SchemeValue; a bare string literal is not a member of that union
        (pred, list) => {
          void pred;
          void list;
          return "not-a-scheme-value";
        },
      );
    }
    expectTypeOf<true>().toEqualTypeOf<true>();
  });
});

describe("symbol contract — 2026-07-05 audit: typecheck's contract narrows to a fixed 4-tuple (3 required + 1 optional)", () => {
  const s1 = z.custom<{ valueOf(): unknown }>();
  const s3 = z.custom<{ valueOf(): unknown } | Function>();
  const s4 = z.custom<number | null>().optional();

  test("NEW shape: a plain 4-element array — the 4th slot's VALUE admits undefined, but there are EXACTLY 4 positions", () => {
    // Mirrors typecheck's real migrated contract exactly (2nd slot z.schemeValue per the audit's other fix).
    expectTypeOf<DecodedArgs<[typeof s1, typeof z.schemeValue, typeof s3, typeof s4]>>().toEqualTypeOf<
      [{ valueOf(): unknown }, SchemeValue, { valueOf(): unknown } | Function, number | null | undefined]
    >();
  });

  test("a 5th argument no longer compiles — the old unbounded-rest gap is closed", () => {
    const RUN = false as boolean;
    if (RUN) {
      symbol.native`tc: proof`(
        { input: [s1, z.schemeValue, s3, s4], output: [z.undefinedResult] },
        // @ts-expect-error — the contract is a fixed 4-tuple; a 5th param has no corresponding decoded arg
        (a, b, c, d, e) => {
          void a;
          void b;
          void c;
          void d;
          void e;
        },
      );
    }
    expectTypeOf<true>().toEqualTypeOf<true>();
  });
});

describe("symbol contract — 2026-07-05 audit: negative proofs", () => {
  test("string-map/string-for-each: a wrong-typed rest element must NOT compile", () => {
    const RUN = false as boolean;
    if (RUN) {
      symbol.native`sm: proof`(
        { input: [z.lambda], inputRest: z.string, output: [z.string] },
        // @ts-expect-error — rest args decode via z.schemeString (AString), annotating them number is wrong
        (proc: (...args: unknown[]) => unknown, ...strings: number[]): string => {
          void proc;
          void strings;
          return "";
        },
      );
    }
    expectTypeOf<true>().toEqualTypeOf<true>();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2026-07-05 audit (srfi-235.ts): curry's contract narrows the leading-args tail to
// SchemeValue, not bare unknown. curry (arrival's arity-aware partial application, kept
// NATIVE — the arity detection can't be pure scheme) uses the SAME callable-schema head
// convention named in the audit note above (`z.custom<(...args: unknown[]) => T>()` — one
// of the 7 call sites: vector-map/vector-for-each's proc, call-with-values's producer/
// consumer, member/assoc's compare predicate, and curry's fn). Its OLD contract authored
// the whole input as ONE manually-built `z.tuple([head], z.unknown())` (no `inputRest`
// field at all); the fix splits it into `input: [head], inputRest: z.schemeValue` — mirroring
// apply's own migrated shape (a fixed callable head + a SchemeValue... tail), matching the
// leading-args being partially-applied are real scheme terms, not representation-blind
// `unknown`. A runtime proof lives alongside it (`env/srfi/__tests__/srfi-235.test.ts`) —
// bakeNative erases the contract's static I/O/Rest on `NativeSymbolDef.in`/`.out`, but the
// WIRED zod schema is NOT erased, so that test reads the real baked def's rest schema off
// the actual srfi-235.ts export (reference-equal to `z.schemeValue` after the fix) rather than a
// synthetic mirror — the two proofs cover what each layer can actually observe.
// ─────────────────────────────────────────────────────────────────────────────
describe("symbol contract — 2026-07-05 audit: curry's contract narrows the leading-args tail to SchemeValue (srfi-235.ts)", () => {
  const curryHead = z.lambda;

  test("NEW curry shape: input=[head], inputRest=z.schemeValue — leading args decode as SchemeValue, not unknown", () => {
    // Mirrors curry's real migrated contract: { input: [z.lambda], inputRest: z.schemeValue, ... }.
    expectTypeOf<DecodedArgsWithRest<[typeof curryHead], typeof z.schemeValue>>().toEqualTypeOf<
      [ACallable, ...SchemeValue[]]
    >();
  });

  test("wrong-typed rest param must NOT compile", () => {
    const RUN = false as boolean;
    if (RUN) {
      symbol.native`curry2: proof`(
        { input: [curryHead], inputRest: z.schemeValue, output: [curryHead] },
        // @ts-expect-error — rest args decode via z.schemeValue (SchemeValue), annotating them string is wrong
        (fn: ACallable, ...args: string[]) => fn,
      );
    }
    expectTypeOf<true>().toEqualTypeOf<true>();
  });
});

describe("symbol.sequence — impl args/return typed via SpecInfer-built DecodedArgs/DecodedReturn, not raw unknown[]", () => {
  test("correctly-typed impl: args destructure to the contract's decoded shape, return matches DecodedReturn", () => {
    const def = symbol.sequence`seqproof: proof`(
      // symbol.sequence always projects the "scheme" face (SequenceImpl, _bake.ts) — z.string's
      // scheme face is AString, not the js-face `string`.
      { input: [z.pair, z.string], output: [z.string] },
      (args: [AListAlike, AString], runCtx) => {
        expectTypeOf(args).toEqualTypeOf<[AListAlike, AString]>();
        return args[1];
      },
    );
    // Stage A2: `symbol.sequence` mints the ANativeProcedure directly now (kind lives on
    // `.contract`, per D1) — the value's OWN `.kind` is the ACallable discriminant
    // ("procedure"), not the contract's "sequence".
    expectTypeOf(def.kind).toEqualTypeOf<"procedure">();
    expectTypeOf((def.contract as { kind: string }).kind).toEqualTypeOf<string>();
  });

  test("wrong-typed impl must NOT compile — args[0] is a Pair, annotating it string is wrong", () => {
    const RUN = false as boolean;
    if (RUN) {
      symbol.sequence`seqproof2: proof`(
        { input: [z.pair], output: [z.pair] },
        // @ts-expect-error — args is [APair], annotating it [string] is wrong
        (args: [string], runCtx) => args[0] as unknown as AListAlike,
      );
    }
    expectTypeOf<true>().toEqualTypeOf<true>();
  });
});

describe("AEntity — the baked, discriminated union (formerly the colliding `SymbolDef` name shared with capability.ts's SymbolDeclaration)", () => {
  test("a baked native def is a member of AEntity", () => {
    expectTypeOf<NativeSymbolDef>().toExtend<AEntity>();
  });

  test("AEntity is exactly the 8-way discriminated union — a bare `{ value: unknown }` binding is NOT a member (that lives only in capability.ts's wider SymbolDeclaration)", () => {
    expectTypeOf<{ value: unknown }>().not.toExtend<AEntity>();
  });
});
