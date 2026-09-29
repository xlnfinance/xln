// lists.test-d.ts — TYPE-LEVEL proofs for the scheme/lists Contract precision fixes.
//
// `NativeSymbolDef.in`/`.out` (and SequenceSymbolDef's) erase to plain `z.ZodTypeAny` on any
// REAL exported capability (see symbol.test-d.ts's "apply's own declared shape" note, and
// numeric.test-d.ts's own header, which established this exact convention) — so, mirroring
// that convention, each proof below is a SYNTHETIC contract mirroring the op's real declared
// shape (built from the SAME scheme-zod.ts schemas lists.ts's fix uses), not a probe of the
// erased runtime export. The RUNTIME proof — "did the fix actually land on the real ops" —
// lives in the sibling `lists-contract-precision.test.ts` (needed because the static erasure
// above makes that type-unobservable here).
//
// Most of THIS file's proofs are STABLE documentation (the shared DecodedArgs/DecodedReturn
// mechanism is unchanged by this fix — only lists.ts's OWN contract declarations change), not
// a RED-before/GREEN-after compile failure — exactly like symbol.test-d.ts's own "2026-07-05
// audit" block and numeric.test-d.ts document their own OLD-vs-NEW shape pairs. The genuine
// red-before/green-after TDD evidence is the RUNTIME file (a schema's precision is only
// observable via zod's own `.safeParse`, per that file's own header note).
import { describe, expectTypeOf, test } from "vitest";
import * as z from "../../../common/scheme-zod/index.js";
import type { DecodedArgs, DecodedArgsWithRest, DecodedReturn } from "../../../common/symbols/_bake.js";
import type { SchemeValue } from "../../../values/types.js";
import type { APair } from "../../../values/primitives/APair.js";

describe("lists Contract precision — cons: car/cdr are z.schemeValue (SchemeValue), not z.custom<unknown>()", () => {
  test("NEW shape (z.schemeValue x2) decodes [SchemeValue, SchemeValue] — matches cons's real migrated contract exactly", () => {
    expectTypeOf<DecodedArgs<[typeof z.schemeValue, typeof z.schemeValue]>>().toEqualTypeOf<
      [SchemeValue, SchemeValue]
    >();
  });
});

describe("lists Contract precision — map (symbol.sequence): a hand-authored z.tuple(fixed, rest) — the ONLY authoring style available (SequenceInput.contract is Contract<I,O>, no Rest generic — see _bake.ts's sequence.ts factory)", () => {
  const mapHead = z.lambda;

  test("output: NEW [z.schemeValue] → SchemeValue", () => {
    expectTypeOf<DecodedReturn<[typeof z.schemeValue]>>().toEqualTypeOf<SchemeValue>();
  });
});

describe("lists Contract precision — make-list: fill is z.schemeValue.optional(), output is z.union([z.pair, z.nil]) (a proper list), not z.custom<unknown>()", () => {
  test("NEW shape: [z.schemeNumber, z.schemeValue.optional()] → [AExact|AInexact, SchemeValue|undefined]", () => {
    expectTypeOf<DecodedArgs<[typeof z.schemeNumber, ReturnType<typeof z.schemeValue.optional>]>>().toEqualTypeOf<
      [z.output<typeof z.schemeNumber>, SchemeValue | undefined]
    >();
  });

  test("output: NEW [z.union([z.pair, z.nil])] → APair | null — make-list ALWAYS returns a proper list (nil when k=0, else a pair chain). `nil` decodes (JS/output face) to `null` now — `AList` (`APair|ANil`) is the SCHEME face, not this one.", () => {
    // NOT ReturnType<typeof z.union<[...]>> (explicit generic-call syntax) — that form makes
    // toEqualTypeOf spuriously fail against ANY hand-written union (a real expect-type
    // limitation, verified directly: even non-generic `string | null` hits it the same way).
    // A runtime-value union (TS infers the type args) doesn't have this problem.
    const makeListOutput = z.union([z.pair, z.nil]);
    expectTypeOf<DecodedReturn<[typeof makeListOutput]>>().toEqualTypeOf<[SchemeValue, SchemeValue] | null>();
  });
});

describe("lists Contract precision — list-tail / list-ref: output is z.schemeValue (SchemeValue), not z.custom<unknown>() — a sublist/element can be ANY scheme value (an improper-list tail, or a bare car), so z.schemeValue (not a pair|nil union) is the honest ceiling", () => {
  test("NEW ([z.schemeValue]) output shape", () => {
    expectTypeOf<DecodedReturn<[typeof z.schemeValue]>>().toEqualTypeOf<SchemeValue>();
  });
});

describe("lists Contract precision — list-set!: obj (3rd, stored arg) is z.schemeValue, not z.custom<unknown>()", () => {
  test("NEW 3-tuple shape decodes [APair|null, AExact|AInexact, SchemeValue] — matches list-set!'s real migrated contract (nil's JS face is null, not ANil — AList is the scheme face)", () => {
    const listSchema = z.union([z.pair, z.nil]);
    expectTypeOf<DecodedArgs<[typeof listSchema, typeof z.schemeNumber, typeof z.schemeValue]>>().toEqualTypeOf<
      [[SchemeValue, SchemeValue] | null, z.output<typeof z.schemeNumber>, SchemeValue]
    >();
  });
});

describe("lists Contract precision — memq/memv/assq/assv/member/assoc: output models the REAL 'match-or-raw-false' domain — z.union([z.schemeValue, z.literal(false)]), not a bare z.custom<unknown>()", () => {
  test("NEW shape [z.union([z.schemeValue, z.literal(false)])] → SchemeValue | false — a matched sublist/entry, or the raw #f sentinel these ops return on no-match (relies on the interpreter's downstream boxing of a raw `false`, the SAME established pattern as length's own AExact(0n)-vs-raw-number note)", () => {
    const matchOrFalse = z.union([z.schemeValue, z.literal(false)]);
    expectTypeOf<DecodedReturn<[typeof matchOrFalse]>>().toEqualTypeOf<SchemeValue | false>();
  });
});

describe("lists Contract precision — member/assoc: obj is z.schemeValue (not z.custom<unknown>()); compare's return type is `unknown` (not `boolean`) — matches srfi-1.ts's filter predicate convention and the is_false-guarded actual usage", () => {
  test("NEW compare schema: (a: unknown, b: unknown) => unknown — honest about a boxed-SchemeBool return (the is_false guard exists precisely because this ISN'T always a raw JS boolean)", () => {
    const newCompare = z.custom<(a: unknown, b: unknown) => unknown>().optional();
    expectTypeOf<DecodedArgs<[typeof newCompare]>>().toEqualTypeOf<
      [((a: unknown, b: unknown) => unknown) | undefined]
    >();
  });

  test("NEW full shape: [z.schemeValue, list, compare?] decodes [SchemeValue, APair|null, ((a,b)=>unknown)|undefined] — matches member/assoc's real migrated contract (nil's JS face is null, not ANil — AList is the scheme face)", () => {
    const listSchema = z.union([z.pair, z.nil]);
    const compare = z.custom<(a: unknown, b: unknown) => unknown>().optional();
    expectTypeOf<DecodedArgs<[typeof z.schemeValue, typeof listSchema, typeof compare]>>().toEqualTypeOf<
      [SchemeValue, [SchemeValue, SchemeValue] | null, ((a: unknown, b: unknown) => unknown) | undefined]
    >();
  });
});

describe("lists Contract precision — index-first access schema (historical pin for polyglot-clojure nth; R7RS uses list-ref)", () => {
  test("NEW shape: [z.schemeNumber, z.custom<unknown>()] decodes [AExact|AInexact, unknown] — matches nth's polyglot-clojure contract", () => {
    expectTypeOf<DecodedArgs<[typeof z.schemeNumber, z.ZodCustom<unknown>]>>().toEqualTypeOf<
      [z.output<typeof z.schemeNumber>, unknown]
    >();
  });
});

describe("lists Contract precision — list->array: output is z.array(z.schemeValue) (SchemeValue[]), not z.custom<unknown>() — matches listToArray's own declared TS return type exactly", () => {
  test("OLD [z.custom<unknown>()] → unknown; NEW [z.array(z.schemeValue)] → SchemeValue[]", () => {
    expectTypeOf<DecodedReturn<[z.ZodCustom<unknown>]>>().toEqualTypeOf<unknown>();
    expectTypeOf<DecodedReturn<[ReturnType<typeof z.array<typeof z.schemeValue>>]>>().toEqualTypeOf<SchemeValue[]>();
  });
});

describe("lists Contract precision — flatten: output is z.union([z.pair, z.nil, z.array(z.custom<unknown>())]) — matches `.flatten()`'s own declared TS return type (APair | ANil | unknown[]) exactly, tighter than a bare z.custom<unknown>()", () => {
  test("the union decodes to APair | null | unknown[] (nil's JS face is null now, and this really is the full 3-member union — the prior AList-migration note here was itself wrong: AList is 2-member and this union has 3)", () => {
    const flattenOutput = z.union([z.pair, z.nil, z.array(z.custom<unknown>())]);
    expectTypeOf<DecodedReturn<[typeof flattenOutput]>>().toEqualTypeOf<
      [SchemeValue, SchemeValue] | null | unknown[]
    >();
  });
});

describe("lists Contract precision — regression guard: the shared inputRest mechanism (apply's own declared shape) is untouched by anything in this file", () => {
  test("apply's own declared shape — same proof symbol.test-d.ts already carries, byte-for-byte", () => {
    expectTypeOf<DecodedArgsWithRest<[typeof z.schemeValue], typeof z.schemeValue>>().toEqualTypeOf<
      [SchemeValue, ...SchemeValue[]]
    >();
  });
});
