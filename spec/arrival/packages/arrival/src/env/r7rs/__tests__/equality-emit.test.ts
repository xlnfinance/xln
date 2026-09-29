// equality-emit.test.ts — Contract.emit on not/null?/pair? (the Phase-2 relocation
// drill, the TS-transpiler constitution §9):
// proves the rule logic relocated from the compiler-side phase1 table onto these
// Contracts builds the exact residual-lite shapes the table rule used to build, by
// calling `emit.call` directly against a synthetic EmitCtx. No compiler package, no
// oracle session, no `typescript` import — matching this whole subpath's own
// typescript-free discipline (§4.5). Mirrors numeric-emit.test.ts's own harness
// exactly (same `testCtx`/`ref` shape) — see that file for the fuller rationale
// comment.
//
// `null?`/`pair?` carry the FULL package deal (§5.3/Law N): `def.narrows` must equal
// `{ witness: <self> }` and `def.refPolicy` must be `"eta"` — not just the residual
// shape. `pair?` is a `tagless-guard` def (declaration-site object spread, no
// `Contract` param), so its helper skips the `kind === "native"` assertion `not`/
// `null?` use.
//
// Byte-parity with the PRE-relocation compiler-side rule is proven on the mercury
// side (`@inhuman.tools/arrival-mercury`): rules-phase1.test.ts's own "not"/
// "null?/pair?" goldens moved to this file's Contract-level proof once the table
// rows were deleted; the narrows-carriage, narrows-fuzz, and cross-pass/gate3 tests
// exercise these through the REAL harvest + walker + render pipeline, unchanged.
import { describe, expect, it } from "vitest";

import type { AEntity } from "../../../common/symbols/_bake.js";
import type { EmitCtx } from "../../../emit/emit-rule.js";
import { Binding, Bin, Call, Lit, Member, Ref, Un, type R } from "../../../emit/residual-lite.js";
import equalityPack from "../equality.js";
import { harvestContracts } from "../../../__tests__/_symbols-harvest.js";

const symbols = harvestContracts(equalityPack.spec.symbols);

function anyDef(name: string): AEntity {
  const def = symbols[name];
  if (def === undefined) throw new Error(`equality pack: no symbol named ${name}`);
  return def;
}

function nativeDef(name: string) {
  const def = anyDef(name);
  if (def.kind !== "native") throw new Error(`equality pack: ${name} is not a native def (got ${def.kind})`);
  return def;
}

function taglessGuardDef(name: string) {
  const def = anyDef(name);
  if (def.kind !== "tagless-guard")
    throw new Error(`equality pack: ${name} is not a tagless-guard def (got ${def.kind})`);
  return def;
}

/** A synthetic EmitCtx, argFacts/config overridable per-call so the fact-gated
 *  null?/pair? branches (and not's register-driven branch) are both reachable.
 *  `door` throws — the SAME observable contract a real `ctx.door` has (a typed
 *  refusal, never a silent miss). */
function testCtx(over: Partial<EmitCtx<R>> = {}): EmitCtx<R> {
  return {
    argFacts: [],
    config: { register: "run" },
    fresh: () => {
      throw new Error("testCtx: fresh() not expected — not/null?/pair? never mint a hygienic temp");
    },
    runtime: (name) => Ref(Binding(`__runtime_${name}`)), // a distinguishable stand-in R value
    door: (reason) => {
      throw new Error(reason);
    },
    ...over,
  };
}

const ref = (name: string): R => Ref(Binding(name));

describe("equality Contract.emit — the Phase-2 relocation drill (not)", () => {
  it("not: the Contract carries the emit rule; no facts → the exact-Scheme guard x === false (Law F)", () => {
    const def = nativeDef("not");
    expect(def.emit).toBeDefined();
    expect(def.narrows).toBeUndefined(); // not a Law-N narrowing leaf
    const x = ref("x");
    expect(def.emit!.call([x], testCtx())).toEqual(Bin("===", x, Lit(false)));
  });

  it("not: argFacts[0].boolean → the clean !x (the flip)", () => {
    const def = nativeDef("not");
    const x = ref("x");
    expect(def.emit!.call([x], testCtx({ argFacts: [{ boolean: true }] }))).toEqual(Un("!", x));
  });

  it("not: read register → clean unconditionally (glass is never executed, §1)", () => {
    const def = nativeDef("not");
    const x = ref("x");
    expect(def.emit!.call([x], testCtx({ config: { register: "read" } }))).toEqual(Un("!", x));
  });

  it("not: a mis-arity call doors (totality — never a silent miscompile)", () => {
    const def = nativeDef("not");
    expect(() => def.emit!.call([], testCtx())).toThrow(/wants exactly 1 argument/);
    expect(() => def.emit!.call([ref("a"), ref("b")], testCtx())).toThrow(/wants exactly 1 argument/);
  });
});

describe("equality Contract.emit — the Phase-2 relocation drill (null? / pair?)", () => {
  it("null?: the FULL package deal — emit + narrows + refPolicy all moved together", () => {
    const def = nativeDef("null?");
    expect(def.emit).toBeDefined();
    expect(def.narrows).toEqual({ witness: "null?" });
    expect(def.refPolicy).toBe("eta");
  });

  it("null?: no facts → the stage-0 shim Call(runtime, [xs]) (the fuzzer's string-collision fix)", () => {
    const def = nativeDef("null?");
    const xs = ref("xs");
    expect(def.emit!.call([xs], testCtx())).toEqual(Call(ref("__runtime_null?"), [xs]));
  });

  it("null?: a proven list/pair/nonEmptyList fact → the clean xs.length === 0 form", () => {
    const def = nativeDef("null?");
    const xs = ref("xs");
    expect(def.emit!.call([xs], testCtx({ argFacts: [{ list: true }] }))).toEqual(
      Bin("===", Member(xs, "length"), Lit(0)),
    );
    expect(def.emit!.call([xs], testCtx({ argFacts: [{ pair: true }] }))).toEqual(
      Bin("===", Member(xs, "length"), Lit(0)),
    );
    expect(def.emit!.call([xs], testCtx({ argFacts: [{ nonEmptyList: true }] }))).toEqual(
      Bin("===", Member(xs, "length"), Lit(0)),
    );
  });

  it("null?: a mis-arity call doors", () => {
    const def = nativeDef("null?");
    expect(() => def.emit!.call([], testCtx())).toThrow(/wants exactly 1 argument/);
  });

  it("pair?: the FULL package deal — a tagless-guard def still carries emit + narrows + refPolicy (declaration-site spread)", () => {
    const def = taglessGuardDef("pair?");
    expect(def.emit).toBeDefined();
    expect(def.narrows).toEqual({ witness: "pair?" }); // self-witnessed — its own runtime behavior PROVES it
    expect(def.refPolicy).toBe("eta");
  });

  it("pair?: no facts → the stage-0 shim Call(runtime, [xs])", () => {
    const def = taglessGuardDef("pair?");
    const xs = ref("xs");
    expect(def.emit!.call([xs], testCtx())).toEqual(Call(ref("__runtime_pair?"), [xs]));
  });

  it("pair?: a proven array-representation fact → the clean xs.length > 0 form", () => {
    const def = taglessGuardDef("pair?");
    const xs = ref("xs");
    expect(def.emit!.call([xs], testCtx({ argFacts: [{ list: true }] }))).toEqual(
      Bin(">", Member(xs, "length"), Lit(0)),
    );
  });

  it("pair?: a mis-arity call doors", () => {
    const def = taglessGuardDef("pair?");
    expect(() => def.emit!.call([], testCtx())).toThrow(/wants exactly 1 argument/);
  });
});

describe("equality Contract.emit — the primitive-proven gate (equal?)", () => {
  it("equal?: the Contract carries the emit rule", () => {
    const def = nativeDef("equal?");
    expect(def.emit).toBeDefined();
    expect(def.narrows).toBeUndefined(); // a value comparison narrows no type
  });

  it("equal?: BOTH operands proven primitive (numeric) → the clean 1 === 1 form (the happy path)", () => {
    const def = nativeDef("equal?");
    const [a, b] = [ref("a"), ref("b")];
    const residual = def.emit!.call([a, b], testCtx({ argFacts: [{ numeric: true }, { numeric: true }] }));
    expect(residual).toEqual(Bin("===", a, b));
  });

  it("equal?: ONLY ONE side proven primitive (numeric/stringy/boolean) → still === (asymmetric ||, not &&) — a primitive can never equal?-match a compound, and === agrees", () => {
    const def = nativeDef("equal?");
    const [a, b] = [ref("a"), ref("b")];
    for (const primitiveFact of [{ numeric: true }, { stringy: true }, { boolean: true }] as const) {
      // primitive fact on the FIRST operand only
      expect(def.emit!.call([a, b], testCtx({ argFacts: [primitiveFact, {}] }))).toEqual(Bin("===", a, b));
      // primitive fact on the SECOND operand only
      expect(def.emit!.call([a, b], testCtx({ argFacts: [{}, primitiveFact] }))).toEqual(Bin("===", a, b));
    }
  });

  it("equal?: the DISCRIMINATING PAIR — neither side proven primitive → the runtime structuralEqual shim, NEVER a bare === (the load-bearing soundness line: (equal? '(1) '(1)) is #t via deep-equal, but the compiled arrays are reference-distinct, so === would wrongly answer #f)", () => {
    const def = nativeDef("equal?");
    const [a, b] = [ref("a"), ref("b")];
    // Neither side proves numeric/stringy/boolean — e.g. both sides are proven
    // `list`/`pair` (compound), or simply unproven (Law F). Either way, no primitive
    // fact fires, so the gate must fall to the shim.
    for (const argFacts of [
      [{}, {}],
      [{ list: true }, { list: true }],
      [{ pair: true }, { pair: true }],
    ] as const) {
      const residual = def.emit!.call(
        [a, b],
        testCtx({ argFacts: [...argFacts], runtime: (name) => Ref(Binding(`__runtime_${name}`)) }),
      );
      expect(residual).toEqual(Call(Ref(Binding("__runtime_equal?")), [a, b]));
    }
  });

  it("equal?: a mis-arity call doors (totality — never a silent miscompile)", () => {
    const def = nativeDef("equal?");
    expect(() => def.emit!.call([ref("a")], testCtx())).toThrow(/wants exactly 2 arguments/);
    expect(() => def.emit!.call([ref("a"), ref("b"), ref("c")], testCtx())).toThrow(/wants exactly 2 arguments/);
  });
});
