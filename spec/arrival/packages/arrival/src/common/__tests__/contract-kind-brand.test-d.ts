// contract-kind-brand — TYPE-LEVEL PROOFS for the Q1 split's compile-time contract-kind ban
// (V ruling, mid-Phase-A — supersedes an earlier bake-time teaching-door draft of this same
// law; docs/plans/stage-c-corpse-deletion.md §"z.value retirement campaign").
//
// LAW (a): `z.schemeValue` banned from rosetta slots; `z.dynamic`/`z.instance` banned from
// native/sequence/define slots. Phantom brands (ContourOnly/CrossingOnly). Mechanism:
// `CrossingContract` / `ContourContract` on the **contract argument** so poisoned *fields*
// glow (`input`/`output`/`inputRest`), not the factory return — `_bake.ts` §1.7.
//
// LAW (b): `z.instance(Ctor)` shares CrossingOnly with `z.dynamic` — banned from contour
// contracts identically (ContourContract gates on brand, not schema name).
//
// NEGATIVE proofs (a banned schema in that position must NOT compile) use `@ts-expect-error`
// over the live factories, exactly like symbol.test-d.ts's own convention — vitest's
// typecheck mode honors `@ts-expect-error`, so each marked line reds if it ever starts
// compiling (the ban silently regressing) or reds a NORMAL type error if the ban's own
// mechanism breaks in some OTHER way (a `@ts-expect-error` with nothing to suppress is
// itself a type-check failure — the same "no free pass" property this style always has).
//
// POSITIVE proofs pin that the SAME slot, in the CORRECT contract kind, compiles clean —
// so a future change to the ban can't accidentally over-trigger and swallow legal contracts.

import { describe, test } from "vitest";
import { EnvCapability } from "../capability.js";

// A plain fixture class — `z.instance(Ctor)`'s type-level ban doesn't need a REAL
// `@arrival.private` brand (that's a runtime-only fact); any constructor shape suffices to
// pin the CONTRACT-KIND type check these proofs are actually about.
class FixtureHandle {}

describe("Q1 compile-time contract-kind ban — z.schemeValue banned from rosetta, z.dynamic banned from native/sequence/define", () => {
  test("z.schemeValue in a rosetta input slot must NOT compile", () => {
    EnvCapability.define("test/ban-schemeValue-rosetta-input", {
      symbols: (symbol, z) => ({
        // @ts-expect-error — z.schemeValue is not legal in a rosetta contract's input; rosetta
        // crosses the membrane, so this slot needs a real codec, z.procedure, or z.dynamic.
        bad: symbol.rosetta`bad: schemeValue in rosetta input`({ input: [z.schemeValue], output: [z.string] }, (v) =>
          String(v),
        ),
      }),
    });
  });

  test("z.schemeValue in a rosetta output slot must NOT compile", () => {
    EnvCapability.define("test/ban-schemeValue-rosetta-output", {
      symbols: (symbol, z) => ({
        bad: symbol.rosetta`bad: schemeValue in rosetta output`(
          // @ts-expect-error — same rule, output side.
          { input: [z.string], output: [z.schemeValue] },
          (s) => s,
        ),
      }),
    });
  });

  test("z.schemeValue in a rosetta kwargs field must NOT compile", () => {
    EnvCapability.define("test/ban-schemeValue-rosetta-kwargs", {
      symbols: (symbol, z) => ({
        bad: symbol.rosetta`bad: schemeValue in rosetta kwargs`(
          // @ts-expect-error — same rule, a kwargs (inputRest shape-record) field.
          // Error lands on the contract object (poisoned `inputRest`), not the factory call.
          { input: [], inputRest: { v: z.schemeValue }, output: [z.string] },
          (args: { v: unknown }) => String(args.v),
        ),
      }),
    });
  });

  test("z.dynamic in a native input slot must NOT compile", () => {
    EnvCapability.define("test/ban-dynamic-native-input", {
      symbols: (symbol, z) => ({
        // @ts-expect-error — z.dynamic is not legal in a native contract's input; a native
        // contour never crosses the membrane, so z.schemeValue (or a real codec) is the honest
        // choice there.
        bad: symbol.native`bad: dynamic in native input`({ input: [z.dynamic], output: [z.boolean] }, function () {
          return true;
        }),
      }),
    });
  });

  test("z.dynamic in a native output slot must NOT compile", () => {
    EnvCapability.define("test/ban-dynamic-native-output", {
      symbols: (symbol, z) => ({
        // @ts-expect-error — same rule, output side.
        bad: symbol.native`bad: dynamic in native output`({ input: [z.string], output: [z.dynamic] }, function (s) {
          return s;
        }),
      }),
    });
  });

  test("z.dynamic in a symbol.define constant contract must NOT compile", () => {
    EnvCapability.define("test/ban-dynamic-define-constant", {
      symbols: (symbol, z) => ({
        // @ts-expect-error — z.dynamic constant: symbol.define bodies are contour, never a
        // membrane crossing.
        bad: symbol.define`bad: dynamic constant`(z.dynamic, `42`),
      }),
    });
  });

  test("POSITIVE: z.schemeValue in native/sequence/define compiles clean (the honest top type is home there)", () => {
    EnvCapability.define("test/ok-schemeValue-contour", {
      symbols: (symbol, z) => ({
        "ok-native": symbol.native`ok-native: schemeValue is legal here`(
          { input: [z.schemeValue], output: [z.schemeValue] },
          function (v) {
            return v;
          },
        ),
        "ok-define": symbol.define`ok-define: schemeValue constant is legal here`(z.schemeValue, `42`),
      }),
    });
  });

  test("POSITIVE: z.dynamic in rosetta compiles clean (the escape hatch is home there)", () => {
    EnvCapability.define("test/ok-dynamic-rosetta", {
      symbols: (symbol, z) => ({
        "ok-rosetta": symbol.rosetta`ok-rosetta: dynamic is legal here`(
          { input: [z.dynamic], output: [z.dynamic] },
          (v) => v,
        ),
      }),
    });
  });

  test("z.instance(Ctor) in a native input slot must NOT compile", () => {
    EnvCapability.define("test/ban-instance-native-input", {
      symbols: (symbol, z) => ({
        bad: symbol.native`bad: instance in native input`(
          // @ts-expect-error — z.instance(Ctor) is not legal in a native contract's input
          { input: [z.instance(FixtureHandle)], output: [z.boolean] },
          function () {
            return true;
          },
        ),
      }),
    });
  });

  test("z.instance(Ctor) in a native output slot must NOT compile", () => {
    EnvCapability.define("test/ban-instance-native-output", {
      symbols: (symbol, z) => ({
        bad: symbol.native`bad: instance in native output`(
          // @ts-expect-error — same rule, output side.
          { input: [z.string], output: [z.instance(FixtureHandle)] },
          function (s) {
            return s;
          },
        ),
      }),
    });
  });

  test("z.instance(Ctor) in a symbol.define constant contract must NOT compile", () => {
    EnvCapability.define("test/ban-instance-define-constant", {
      symbols: (symbol, z) => ({
        // @ts-expect-error — z.instance(Ctor) constant: symbol.define bodies are contour,
        // never a membrane crossing.
        bad: symbol.define`bad: instance constant`(z.instance(FixtureHandle), `42`),
      }),
    });
  });

  test("POSITIVE: z.instance(Ctor) in rosetta compiles clean (the semi-opaque handle is home there)", () => {
    EnvCapability.define("test/ok-instance-rosetta", {
      symbols: (symbol, z) => ({
        "ok-rosetta": symbol.rosetta`ok-rosetta: instance(Ctor) is legal here`(
          { input: [z.instance(FixtureHandle)], output: [z.instance(FixtureHandle)] },
          (v) => v,
        ),
      }),
    });
  });
});
