// schema-to-ts — the harvest printer's verdict suite. Proves the zod-schema → TS
// type-STRING mapping is exact for: native identity primitives, the rosetta codec
// family, compounds (object/array/tuple/union), and the full `signatureOf` over a
// sampled native def, a rosetta def, and a multiple-values output.
import { schemeTrue } from "../../values/primitives/ABool.js";
import { describe, expect, it } from "vitest";
import * as z from "../../common/scheme-zod/index.js";
import { symbol } from "../../symbol/index.js";
import { withContractFields } from "../../common/symbols/_bake.js";
import { contractOf } from "../../common/capability-internals.js";
import { printType, signatureOf, sTagToTsType } from "../schema-to-ts.js";

/** Test-only cast — `signatureOf` reads an `AEntity` CONTRACT; pull it via `contractOf` before handing it to the printer. */
function sig(def: Parameters<typeof contractOf>[0]): string {
  return signatureOf(contractOf(def)!);
}

describe("printType — native identity primitives (scheme primitive → plain-TS image)", () => {
  // `z.pair` is `cons(schemeValue, schemeValue)` — a real codec named "cons", not a
  // bare-instanceof "pair" — so it prints via the named-generic pre-check as
  // `Tuple<SchemeValue, SchemeValue>`, same as any other `cons(A, B)`; `z.union([z.pair,
  // z.nil])` composes structurally member-by-member (no "pair"→List-style name override).
  // The numeric tower: exact and inexact both print "number" via the name-keyed image, not
  // the raw union — z.bigint is retired (exact is a safe-integer ratio of `number`s per
  // docs/design-history/arrival-one-number-rework.md §2.3). schemeNumber has no name-image of
  // its own → composed per-member, undeduped ("number | number" — same known gap as z.vector
  // below, ledger/index.law.test.ts GAPS: "schema-to-ts vector union not deduped").
  it.each([
    {
      name: "z.pair → Tuple<SchemeValue, SchemeValue> (cons(schemeValue, schemeValue), not a standalone name)",
      schema: z.pair,
      expected: "Tuple<SchemeValue, SchemeValue>",
    },
    { name: "z.string → string", schema: z.string, expected: "string" },
    { name: "z.bigint (exact) → number", schema: z.bigint, expected: "number" },
    { name: "z.inexact → number", schema: z.inexact, expected: "number" },
    { name: "z.symbol → string", schema: z.symbol, expected: "string" },
    { name: "z.bytevector → Uint8Array", schema: z.bytevector, expected: "Uint8Array" },
    { name: "z.nil → null", schema: z.nil, expected: "null" },
    { name: "z.boolean → boolean", schema: z.boolean, expected: "boolean" },
    { name: "z.char → string", schema: z.char, expected: "string" },
    // Q1 SPLIT (docs/plans/stage-c-corpse-deletion.md §"z.value retirement campaign"): the ONE
    // `isSchemeValue` predicate mints under TWO names, printing DIFFERENTLY despite identical
    // runtime behavior — `schemeValue` is the HONEST TOP TYPE (a real type reference,
    // `SchemeValue`, not the bare keyword); `dynamic` (the rosetta escape hatch) prints the
    // honest-but-generic `unknown`. The deprecated `value` alias (a third name, same printer
    // arm) is GONE — Phase B deleted it, scheme-zod.ts's own registration along with it.
    { name: "z.schemeValue (the honest top type) → SchemeValue", schema: z.schemeValue, expected: "SchemeValue" },
    { name: "z.dynamic (the rosetta escape hatch) → unknown", schema: z.dynamic, expected: "unknown" },
    {
      name: "z.lambda → a callable signature, not degraded to unknown",
      schema: z.lambda,
      expected: "(...args: unknown[]) => unknown",
    },
    {
      name: "a union of primitives (z.schemeNumber) → 'number | number' (override fires per-member, undeduped)",
      schema: z.schemeNumber,
      expected: "number | number",
    },
    {
      name: "the list union z.pair | z.nil → Tuple<SchemeValue, SchemeValue> | null",
      schema: z.union([z.pair, z.nil]),
      expected: "Tuple<SchemeValue, SchemeValue> | null",
    },
  ])("prints $name", ({ schema, expected }) => {
    expect(printType(schema)).toBe(expected);
  });

  // GAP (ledger/index.law.test.ts GAPS: "schema-to-ts vector union not deduped", gate:
  // "printer dedup follow-up"). vector(E) = union[array(E), array(E)] (two same-output codec
  // branches), and `vector` carries no name-image (its element varies), so it prints the
  // duplicated `unknown[] | unknown[]`. TS collapses it to `unknown[]` at the type level; the
  // IDEAL is a harvest union-member dedup that cleans the printed string to match. Flips green
  // when that dedup lands.
  it.fails("prints z.vector(z.dynamic) deduped as 'unknown[]', not the duplicated union branches", () => {
    expect(printType(z.vector(z.dynamic))).toBe("unknown[]");
  });
});

describe("printType — unregistered custom leaf hardens to unknown, never throws", () => {
  // Not in scheme-zod.ts's NAMES map → lookupName(schema) is undefined. Before the
  // hardening fix this deferred to zod-to-ts's unrepresentable:"throw" and blew up.
  const unregisteredLeaf = z.custom<{ notAVocabItem: true }>((v) => typeof v === "object");

  it.each([
    {
      name: "a bare unregistered custom leaf degrades to 'unknown'",
      schema: unregisteredLeaf,
      expected: "unknown",
    },
    {
      name: "only the unregistered member inside a union degrades to unknown, sibling members unaffected",
      schema: z.union([z.string, unregisteredLeaf]),
      expected: "string | unknown",
    },
  ])("$name", ({ schema, expected }) => {
    expect(printType(schema)).toBe(expected);
  });
});

describe("printType — rosetta codecs (decoded JS side, io:output)", () => {
  // One row per codec — its decoded JS type. The number-codec family (number/integer/bigint)
  // prints by its declared JS type — z.bigint's face is "number" too (retired; exact is a
  // safe-integer ratio of `number`s). looseNumber / looseAnyNumber print by decoded JS type
  // (IMAGE_BY_NAME) — without images their OUT z.custom leaf would harvest as unknown
  // (floor/abs collapse); looseAnyNumber's face is plain "number" now too (z.bigint retired).
  it.each([
    { name: "the string codec → 'string'", schema: z.string, expected: "string" },
    { name: "the boolean codec → its decoded JS type", schema: z.boolean, expected: "boolean" },
    { name: "the char codec → its decoded JS type", schema: z.char, expected: "string" },
    { name: "the number codec → its declared JS type", schema: z.number, expected: "number" },
    { name: "the integer codec → its declared JS type", schema: z.integer, expected: "number" },
    { name: "the bigint codec → its declared JS type", schema: z.bigint, expected: "number" },
    { name: "the loose number codec → its decoded JS type", schema: z.looseNumber, expected: "number" },
    { name: "the loose-any-number codec → its decoded JS type", schema: z.looseAnyNumber, expected: "number" },
  ])("prints $name", ({ schema, expected }) => {
    expect(printType(schema)).toBe(expected);
  });
});

describe("printType — compounds", () => {
  // `z.pair` prints `Tuple<SchemeValue, SchemeValue>` — see the native-identity describe.
  it.each([
    {
      name: "z.object as a single-line member list (no dangling semicolon)",
      schema: z.object({ k: z.string, n: z.number }),
      expected: "{ k: string; n: number }",
    },
    {
      name: "z.array as variadic 'T[]' (codec element decoded)",
      schema: z.array(z.number),
      expected: "number[]",
    },
    {
      name: "z.array of an identity primitive as 'T[]'",
      schema: z.array(z.pair),
      expected: "Tuple<SchemeValue, SchemeValue>[]",
    },
    { name: "a tuple as '[A, B]'", schema: z.tuple([z.string, z.number]), expected: "[string, number]" },
    {
      name: "a tuple mixing codec + identity members",
      schema: z.tuple([z.pair, z.string]),
      expected: "[Tuple<SchemeValue, SchemeValue>, string]",
    },
    { name: "a union as 'A | B'", schema: z.union([z.string, z.number]), expected: "string | number" },
  ])("prints $name", ({ schema, expected }) => {
    expect(printType(schema)).toBe(expected);
  });
});

describe("sTagToTsType — the s/* schema-DSL tag → TS type-string bridge", () => {
  // `additionalProperties: false` would print `[x: string]: never` via zod; the lens
  // strips that (structural objects already reject unknown keys; never-index is hover noise).
  it.each([
    {
      name: "an object tag's scalar fields",
      tag: ["object", ["title", "string"], ["count", "number"]] as const,
      expected: "{ title: string; count: number }",
    },
    {
      name: "a field description prints as a JSDoc comment (zod-to-ts's own convention)",
      tag: ["object", ["summary", "string", "a one-line summary"]] as const,
      expected: "{ /** a one-line summary */ summary: string }",
    },
    {
      name: "a nested array field",
      tag: ["object", ["tags", ["array", "string"]]] as const,
      expected: "{ tags: string[] }",
    },
    {
      name: "a nested object field (closed-never stripped at every level)",
      tag: ["object", ["author", ["object", ["name", "string"]]]] as const,
      expected: "{ author: { name: string } }",
    },
    {
      name: "an optional field's /optional suffix drops it from `required` — TS marks it `?` (zod's own `?: T | undefined`)",
      tag: ["object", ["title", "string"], ["nickname", "string/optional"]] as const,
      expected: "{ title: string; nickname?: string | undefined }",
    },
  ])("prints $name", ({ tag, expected }) => {
    expect(sTagToTsType(tag)).toBe(expected);
  });

  it("a malformed/unrepresentable tag degrades to unknown, never throws", () => {
    expect(sTagToTsType(["object", ["bad"]])).toBe("unknown");
    expect(sTagToTsType(null)).not.toBeUndefined();
  });
});

describe("signatureOf — the args-vector → function-signature composer", () => {
  it("honors an author-asserted `type` override on the contract — the zod schema stays the MEMBRANE description (runtime decode/validate), `type` is a separate, decoupled TYPE-LEVEL narrowing for the harvest (mirrors author `type` override/RosettaFunction.type)", () => {
    const def = symbol.native`typed-override: proof`(
      { input: [z.schemeValue], output: [z.schemeValue], type: "(ip: SchemeIP) => SchemeIP" },
      (a) => a,
    );
    expect(sig(def)).toBe("(ip: SchemeIP) => SchemeIP");
  });

  it("honors a dual type-guard `type` on a native type predicate", () => {
    const dual = "{ (x: unknown): x is string; <T>(x: T): x is Extract<T, string>; }";
    const def = symbol.native`string?: proof`(
      { input: [z.schemeValue], output: [z.boolean], type: dual },
      () => schemeTrue,
    );
    expect(sig(def)).toBe(dual);
  });

  it("honors a dual type-guard `type` on a taglessGuard type predicate", () => {
    const dual = "{ (x: unknown): x is readonly unknown[]; <T>(x: T): x is Extract<T, readonly any[]>; }";
    const def = withContractFields(symbol.taglessGuard`vector?: proof`, { type: dual });
    expect(sig(def)).toBe(dual);
  });

  it("composes a native def: scheme-value args, sync return, single-value output", () => {
    const def = symbol.native`cons: build a pair`({ input: [z.pair, z.pair], output: [z.pair] }, (a) => a);
    expect(sig(def)).toBe(
      "(a: Tuple<SchemeValue, SchemeValue>, b: Tuple<SchemeValue, SchemeValue>) => Tuple<SchemeValue, SchemeValue>",
    );
  });

  it("composes a rosetta def: decoded JS args, async (Promise) return", () => {
    const def = symbol.rosetta`pad: left-pad a string to a width`(
      { input: [z.string, z.number], output: [z.string] },
      (s) => s,
    );
    expect(sig(def)).toBe("(a: string, b: number) => Promise<string>");
  });

  it("composes a multiple-values rosetta output as a tuple inside Promise", () => {
    const def = symbol.rosetta`divmod: quotient and remainder`(
      { input: [z.number], output: [z.number, z.number] },
      (n) => [n, n] as [number, number],
    );
    expect(sig(def)).toBe("(a: number) => Promise<[number, number]>");
  });

  it("composes a multiple-values NATIVE output as a bare tuple (sync)", () => {
    const def = symbol.native`split: car and cdr`(
      { input: [z.pair], output: [z.pair, z.pair] },
      (p) => [p, p] as [typeof p, typeof p],
    );
    expect(sig(def)).toBe(
      "(a: Tuple<SchemeValue, SchemeValue>) => [Tuple<SchemeValue, SchemeValue>, Tuple<SchemeValue, SchemeValue>]",
    );
  });

  it("composes a variadic (z.array) input as a rest parameter", () => {
    const def = symbol.rosetta`sum: add all numbers`(
      { input: z.array(z.number), output: [z.number] },
      (...ns: number[]) => ns.reduce((a, b) => a + b, 0),
    );
    expect(sig(def)).toBe("(...args: number[]) => Promise<number>");
  });

  it("composes a 0-arg contract as '()'", () => {
    const def = symbol.rosetta`now: current epoch millis`({ input: [], output: [z.number] }, () => Date.now());
    expect(sig(def)).toBe("() => Promise<number>");
  });

  it("renders an omitted-verb door as 'never' (not callable)", () => {
    const def = symbol.notImplemented`eval: arbitrary evaluation is a door`;
    expect(sig(def)).toBe("never");
  });

  // INVARIANT: a kwargs (inputRest object) input composes as a single plain-object parameter
  // with optional fields marked `?:`.
  it("composes a kwargs (object) input as a plain object param (the model fills it as :key value)", () => {
    const def = symbol.rosetta`create_user: make a user`(
      { input: [], inputRest: { name: z.string, mode: z.enum(["fast", "scenic"]).optional() }, output: [z.string] },
      () => "",
    );
    expect(sig(def)).toBe('(a: { name: string; mode?: ("fast" | "scenic") | undefined }) => Promise<string>');
  });
});
