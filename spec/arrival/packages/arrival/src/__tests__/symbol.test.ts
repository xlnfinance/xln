// symbol.test.ts — the `arrival.symbol*` API.
//
// TEST-FIRST proof surface for env/symbol.ts + env/scheme-zod.ts. Two planes:
//   • RUNTIME (vitest): codec decode/encode, the number-codec family, validation
//     rejection (errors-as-doors), gating, native-runs-no-validation, async,
//     variadic, multiple-values, notImplemented → door.
//   • TYPE (compile-time): the generic inference proofs live in env/symbol.ts itself
//     (it is the file `pnpm typecheck` actually compiles — *.test.ts is excluded from
//     both tsconfigs). The `@ts-expect-error` lines below DOCUMENT the same proofs and
//     are enforced by an explicit `tsc` over this file during verification.

import { describe, it, expect, expectTypeOf } from "vitest";
import { CONSTANT_CTX } from "../run/RunContext.js";
import * as arrival from "../symbol/index.js";
import { testCallCtx } from "../run/CallCtx.js";
import * as z from "../common/scheme-zod/index.js";
import { APair } from "../values/primitives/APair.js";
import { AValue } from "../values/primitives/AValue.js";
import type { SchemeValue } from "../values/types.js";
import { AString } from "../values/primitives/AString.js";
import { AExact } from "../values/primitives/AExact.js";
import { AInexact } from "../values/primitives/AInexact.js";
import { nil } from "../values/primitives/ANil.js";
import type { NativeSymbolDef } from "../values/primitives/ANativeProcedure.js";
import type { RosettaSymbolDef } from "../common/symbols/_bake.js";

const { symbol } = arrival;

/** Test-only cast: pull a minted value's `.contract` (typed `unknown` on the class — see
 *  ACallable.ts) back to its known CONTRACT shape, for direct introspection — this whole
 *  suite's point. Stage A2: `symbol.native`/`symbol.rosetta` mint the ANativeProcedure/
 *  ARosettaProcedure directly now; the def they used to RETURN rides `.contract` on it. */
function contractOf<T>(v: { contract: unknown }): T {
  return v.contract as T;
}

function fire(proc: { ["arrival/tagless-final/apply"](args: any[], callCtx: any): any }, callCtx: any, ...args: any[]) {
  return proc["arrival/tagless-final/apply"](args, callCtx);
}

describe("symbol.native — scheme-identity, no validation", () => {
  it("infers the impl arg+return as SCHEME VALUES from identity schemas", () => {
    const def = symbol.native`pair-id: identity on a pair`({ input: [z.pair], output: [z.pair] }, (p) => {
      // z.pair is cons(schemeValue, schemeValue); scheme face keeps the APair box.
      // Element type is SchemeValue (not the abstract AValue base — not a union member).
      expectTypeOf(p).toEqualTypeOf<APair<SchemeValue, SchemeValue>>();
      return p;
    });
    // Stage A2: `symbol.native` mints the ANativeProcedure directly — the CONTRACT
    // (kind/name/doc/impl/…) rides `.contract` on it now.
    expect(contractOf<NativeSymbolDef | RosettaSymbolDef>(def).kind).toBe("native");
    expect(contractOf<NativeSymbolDef | RosettaSymbolDef>(def).name).toBe("pair-id");
    expect(contractOf<NativeSymbolDef>(def).doc).toBe("identity on a pair");
  });

  it("runs the impl on the raw scheme term with NO decode/validate", () => {
    const def = symbol.native`car-ish: first of a pair`(
      { input: [z.pair], output: [z.string] },
      (p) => p.car as AString,
    );
    const arg = new APair(new AString("hello"), nil);
    // native.contract.impl is the raw host fn — it receives the scheme value directly
    // (the ANativeProcedure's own `arrival/tagless-final/apply` term is the args/callCtx
    // adapter around it; this is the pre-adaptation impl the factory closed over).
    const out = contractOf<NativeSymbolDef>(def).impl(arg);
    expect(out).toBeInstanceOf(AString);
    expect((out as AString)["arrival/toJS"]()).toBe("hello");
  });

  it("does NOT reject a value the identity schema wouldn't accept (no runtime validation)", () => {
    const def = symbol.native`as-is: passthrough`({ input: [z.pair], output: [z.pair] }, (p) => p);
    // A NON-Pair would fail a zod parse, but native never parses — it just runs.
    const notAPair = { car: 1, cdr: 2 } as unknown as APair<any, any>;
    expect(() => contractOf<NativeSymbolDef>(def).impl(notAPair)).not.toThrow();
  });
});

describe("symbol.rosetta — JS-land, codec decode/encode", () => {
  it("infers the impl arg+return as DECODED JS values from codecs", () => {
    const def = symbol.rosetta`strlen: length of a string`({ input: [z.string], output: [z.number] }, (s) => {
      expectTypeOf(s).toEqualTypeOf<string>();
      return s.length;
    });
    expect(contractOf<NativeSymbolDef | RosettaSymbolDef>(def).kind).toBe("rosetta");
    expect(contractOf<NativeSymbolDef | RosettaSymbolDef>(def).name).toBe("strlen");
  });

  it("decodes scheme args → JS, runs impl, encodes return → scheme", async () => {
    const def = symbol.rosetta`strlen: length of a string`({ input: [z.string], output: [z.number] }, (s) => s.length);
    const out = await fire(def, testCallCtx(), new AString("hello"));
    // output codec is z.number → encode(number) = SchemeInexact (the chosen float type).
    expect(out).toBeInstanceOf(AInexact);
    expect((out as AInexact).real).toBe(5);
  });

  it("rejects a bad arg via the input codec (errors-as-doors)", async () => {
    const def = symbol.rosetta`strlen: length of a string`({ input: [z.string], output: [z.number] }, (s) => s.length);
    await expect(fire(def, testCallCtx(), new AExact(3))).rejects.toThrow();
  });

  it("can SKIP validation (trusted call site) but still runs the codec transform", async () => {
    const def = symbol.rosetta`echo: identity string`({ input: [z.string], output: [z.string] }, (s) => s, {
      validate: false,
    });
    const out = await fire(def, testCallCtx(), new AString("x"));
    expect(out).toBeInstanceOf(AString);
    expect((out as AString)["arrival/toJS"]()).toBe("x");
  });

  it("awaits an async impl", async () => {
    const def = symbol.rosetta`async-up: async uppercase`({ input: [z.string], output: [z.string] }, async (s) => {
      await Promise.resolve();
      return s.toUpperCase();
    });
    const out = await fire(def, testCallCtx(), new AString("hi"));
    expect((out as AString)["arrival/toJS"]()).toBe("HI");
  });
});

describe("CallCtx is mandatory on the apply term — misuse THROWS, never silently CONSTANT_CTX", () => {
  // The apply spine reads callCtx.runCtx / callCtx.invocation. A missing or hollow CallCtx
  // must throw loudly, never degrade to CONSTANT_CTX (the silent fallback hid the B2-rosetta
  // mint regression until conservation.law caught it).
  it("apply with undefined callCtx throws instead of silently defaulting", async () => {
    const def = symbol.rosetta`strlen: length of a string`({ input: [z.string], output: [z.number] }, (s) => s.length);
    await expect(fire(def, undefined as any, new AString("hello"))).rejects.toThrow();
  });

  it("apply with an ad hoc `{}` callCtx (missing runCtx/invocation) throws the same way", async () => {
    const def = symbol.rosetta`strlen: length of a string`({ input: [z.string], output: [z.number] }, (s) => s.length);
    await expect(fire(def, {} as any, new AString("hello"))).rejects.toThrow();
  });

  it("testCallCtx() is a real CallCtx — the sanctioned idiom never doors", async () => {
    const def = symbol.rosetta`strlen: length of a string`({ input: [z.string], output: [z.number] }, (s) => s.length);
    const out = await fire(def, testCallCtx(), new AString("hello"));
    expect((out as AInexact).real).toBe(5);
  });
});

describe("the number codec FAMILY — exactness + range + JS-type declared by the codec", () => {
  describe("z.number ↔ JS number (encode → inexact)", () => {
    it("decodes a safe-integer exact and a float inexact to JS number", async () => {
      const def = symbol.rosetta`dbl: double`({ input: [z.number], output: [z.number] }, (n) => n * 2);
      const fromExact = await fire(def, testCallCtx(), new AExact(21));
      expect((fromExact as AInexact).real).toBe(42);
      const fromInexact = await fire(def, testCallCtx(), new AInexact(1.5));
      expect((fromInexact as AInexact).real).toBe(3);
    });

    it("an over-range exact integer can no longer even be constructed (RATIO's construction-time gate, §0.2)", () => {
      // Pre-rework this doored at the z.number CODEC's decode step (a live, constructed
      // over-range AExact reaching a native's arg decode). Post-rework there is no later
      // gate to reach — AExact's own constructor enforces Number.isSafeInteger on every
      // component, so an over-range exact integer throws at construction, earlier than any
      // codec ever sees it (docs/design-history/arrival-one-number-rework.md §0.2/§0.3).
      expect(() => new AExact(Number.MAX_SAFE_INTEGER + 10)).toThrow(/safe integer/i);
    });

    it("DOORS a non-integer exact rational", async () => {
      const def = symbol.rosetta`idn2: identity number`({ input: [z.number], output: [z.number] }, (n) => n);
      await expect(fire(def, testCallCtx(), new AExact(1, 3))).rejects.toThrow(/faithful JS number|rational/i);
    });
  });

  describe("z.integer ↔ JS number constrained to safe ints (encode → exact)", () => {
    it("decodes a safe int and encodes the return as EXACT", async () => {
      const def = symbol.rosetta`inc: increment`({ input: [z.integer], output: [z.integer] }, (n) => n + 1);
      const out = await fire(def, testCallCtx(), new AExact(41));
      expect(out).toBeInstanceOf(AExact);
      expect((out as AExact).num).toBe(42);
      expect((out as AExact).denom).toBe(1);
    });

    it("DOORS a non-safe-integer inexact input", async () => {
      const def = symbol.rosetta`idi: identity int`({ input: [z.integer], output: [z.integer] }, (n) => n);
      await expect(fire(def, testCallCtx(), new AInexact(1.5))).rejects.toThrow(/safe integer/i);
    });
  });

  // RE-PINNED (one-number rework, RATIO — docs/design-history/arrival-one-number-rework.md
  // §2.3): `z.bigint` is retired as the active numeric cast but KEPT exported as a thin
  // compat shim (scheme-zod.ts's own header comment on `bigint`) for consumers outside this
  // sweep's scope. It no longer carries arbitrary precision — AExact's payload is a safe-int
  // `number` by construction (§0.2), so there is no magnitude class beyond
  // Number.MAX_SAFE_INTEGER a live AExact could ever hold; the codec's `encode` arm doors on
  // exactly that boundary instead of silently widening. The suite below was the OLD codec's
  // headline case ("faithful beyond safe-integer range") — now the opposite is true and
  // pinned instead: round-trips SMALL bigints faithfully, DOORS on anything past safe-int.
  describe("z.bigint ↔ JS bigint (thin compat shim, safe-int only post-rework — §2.3)", () => {
    it("DOORS encoding a bigint beyond safe-integer range (no more arbitrary precision)", async () => {
      // The INPUT itself must stay a constructible (safe-int) AExact — a huge value can no
      // longer exist as a live AExact at all (§0.2's construction invariant). Push it over
      // the boundary via the impl's own arithmetic instead: MAX_SAFE_INTEGER + 1n === 2^53,
      // which is NOT a safe integer (Number.isSafeInteger(2^53) is false) — the OUTPUT
      // codec's encode arm is where this now doors, not construction of the input.
      const def = symbol.rosetta`bigid: identity bigint`({ input: [z.bigint], output: [z.bigint] }, (n) => n + 1n);
      const maxSafe = new AExact(Number.MAX_SAFE_INTEGER);
      await expect(fire(def, testCallCtx(), maxSafe)).rejects.toThrow(/safe-integer/i);
    });

    it("infers the impl arg as bigint", () => {
      symbol.rosetta`bg: bigint impl`({ input: [z.bigint], output: [z.bigint] }, (n) => {
        expectTypeOf(n).toEqualTypeOf<bigint>();
        return n;
      });
    });

    it("round-trips a SMALL bigint → scheme → bigint (safe-int only)", async () => {
      const def = symbol.rosetta`bid: bigint identity`({ input: [z.bigint], output: [z.bigint] }, (n) => n);
      const out = (await fire(def, testCallCtx(), new AExact(7))) as AExact;
      const back = z.decode(z.bigint, out);
      expect(back).toBe(7n);
    });
  });
});

describe("variadic + multiple values", () => {
  it("z.array input → variadic impl args", async () => {
    const def = symbol.rosetta`sum: sum of numbers`(
      { input: z.array(z.number), output: [z.number] },
      (...ns: number[]) => ns.reduce((a, b) => a + b, 0),
    );
    const out = await fire(def, testCallCtx(), new AExact(1), new AExact(2), new AExact(3));
    expect((out as AInexact).real).toBe(6);
  });

  it("z.array output → multiple return values (a scheme values vector)", async () => {
    const def = symbol.rosetta`dup: echo two strings`({ input: [z.string], output: z.array(z.string) }, (s) => [s, s]);
    const out = await fire(def, testCallCtx(), new AString("a"));
    // encode of z.array(z.string) → a JS array of SchemeStrings (the values-vector).
    expect(Array.isArray(out)).toBe(true);
    const vec = out as AString[];
    expect(vec).toHaveLength(2);
    expect(vec[0]["arrival/toJS"]()).toBe("a");
  });
});

describe("symbol.notImplemented — errors-as-doors", () => {
  it("mints a DoorProcedure carrying name + teaching reason", () => {
    // Stage A2: `symbol.notImplemented` mints the DoorProcedure directly — the CONTRACT
    // (kind/name/reason/cause) rides `.door` on it now.
    const def = symbol.notImplemented`set!: set! mutates — violates value provenance (R7RS §4.1.6 omitted)`;
    expect(def.door.kind).toBe("door");
    expect(def.door.name).toBe("set!");
    expect(def.door.reason).toMatch(/mutates/);
  });

  // DoorCause (docs/design-history/symbol-define-static-program-validation.md §3.3) — signature/
  // return-shape SOURCE-COMPATIBILITY pin: the factory still bakes no `cause` at all. It
  // cannot know its own owning capability (it runs inside a `symbols` record literal,
  // before the `EnvCapability` wrapping it exists) — `common/capability.ts`'s door bind
  // arm stamps `cause` separately, at apply.
  it("bakes NO `cause` — the factory has no owning capability to stamp yet", () => {
    const def = symbol.notImplemented`stub: a teaching stub`;
    expect(def.door.cause).toBeUndefined();
  });
});

describe("name/doc parsing", () => {
  it("splits on the first colon; trims; tolerates a missing colon", () => {
    const withColon = symbol.notImplemented`a: b: c`;
    expect(withColon.door.name).toBe("a");
    expect(withColon.door.reason).toBe("b: c");
    const noColon = symbol.notImplemented`bare-name`;
    expect(noColon.door.name).toBe("bare-name");
    expect(noColon.door.reason).toBe("");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// TYPE-LEVEL PROOFS (documentation; enforced by the explicit tsc verification run).
// The canonical, `pnpm typecheck`-enforced versions live in env/symbol.ts.
// ─────────────────────────────────────────────────────────────────────────────
describe("type inference (compile-time)", () => {
  it("a wrong-typed native impl is a compile error", () => {
    symbol.native`bad-native: wrong impl`(
      { input: [z.pair], output: [z.pair] },
      // @ts-expect-error
      (p: string) => new APair(p, nil),
    );
    expect(true).toBe(true);
  });

  it("a wrong-typed rosetta impl is a compile error", () => {
    symbol.rosetta`bad-rosetta: wrong impl`(
      { input: [z.string], output: [z.number] },
      // @ts-expect-error — impl receives a decoded string, not a Pair
      (s: APair<any, any>) => s as unknown as number,
    );
    expect(true).toBe(true);
  });

  it("a wrong-typed rosetta RETURN is a compile error", () => {
    symbol.rosetta`bad-return: wrong return`(
      { input: [z.string], output: [z.number] },
      // @ts-expect-error — output codec wants a number, impl returns a string
      (s) => s,
    );
    expect(true).toBe(true);
  });
});
