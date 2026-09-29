// numeric-emit.test.ts — Contract.emit on quotient/modulo/= and +/-/*// (the Phase-2
// relocation drill, the TS-transpiler constitution §9): proves the rule logic
// relocated from the compiler-side phase1 table onto these Contracts builds the exact
// residual-lite shapes the table rule used to build, by calling `emit.call` directly
// against a synthetic EmitCtx. No compiler package, no oracle session, no
// `typescript` import — matching this whole subpath's own typescript-free discipline
// (§4.5).
//
// Byte-parity with the PRE-relocation compiler-side rule is proven on the mercury
// side (`@inhuman.tools/arrival-mercury`): the differential oracle's bug-cell rows
// (quotient-neg, modulo-neg, exact-vs-inexact-eq — arithmetic has no dedicated row of
// its own; `+`/`-`/`*`/`/` are already exercised pervasively across the existing
// corpus) and the cross-pass/gate3 goldens exercise these through the REAL harvest +
// walker + render pipeline, unchanged. This file proves the narrower,
// arrival-core-owned claim: the Contract's own `emit` field is wired, and its `call`
// builds the expected tree in isolation from the compiler.
import { describe, expect, it } from "vitest";

import type { AEntity } from "../../../common/symbols/_bake.js";
import type { EmitCtx } from "../../../emit/emit-rule.js";
import { Bin, Binding, Call, Lit, Method, Ref, Un, type R } from "../../../emit/residual-lite.js";
import numericPack from "../numeric.js";
import { harvestContracts } from "../../../__tests__/_symbols-harvest.js";

const symbols = harvestContracts(numericPack.spec.symbols);

function nativeDef(name: string) {
  const def = symbols[name];
  if (def === undefined) throw new Error(`numeric pack: no symbol named ${name}`);
  if (def.kind !== "native") throw new Error(`numeric pack: ${name} is not a native def (got ${def.kind})`);
  return def;
}

/** A synthetic EmitCtx — no namer, no runtime module, no register bias (`register`
 *  only matters to rules that branch on the read/run split; none of quotient/modulo/=
 *  do). `door` throws — the SAME observable contract a real `ctx.door` has (a typed
 *  refusal, never a silent miss), so a mis-arity call is assertable via `toThrow`.
 *  `argFacts`/`runtime` are overridable (Partial merge) — the fact-gated `< <= > >=`/
 *  `zero?` rules below need both: `argFacts` to reach their proven/unproven branches,
 *  `runtime` to return a distinguishable stand-in for the shim branch (mirrors
 *  equality-emit.test.ts's own `testCtx` shape exactly). */
function testCtx(over: Partial<EmitCtx<R>> = {}): EmitCtx<R> {
  return {
    argFacts: [],
    config: { register: "run" },
    fresh: () => {
      throw new Error("testCtx: fresh() not expected — none of these rules mint a hygienic temp");
    },
    runtime: (name) => {
      throw new Error(`testCtx: runtime(${name}) not expected — override \`runtime\` for the one branch that needs it`);
    },
    door: (reason) => {
      throw new Error(reason);
    },
    ...over,
  };
}

const ref = (name: string): R => Ref(Binding(name));

describe("numeric Contract.emit — the Phase-2 relocation drill (quotient/modulo/=)", () => {
  it("quotient: the Contract carries the emit rule; call builds Math.trunc(a / b)", () => {
    const def = nativeDef("quotient");
    expect(def.emit).toBeDefined();
    expect(def.narrows).toBeUndefined(); // not a Law-N narrowing leaf
    const [a, b] = [ref("a"), ref("b")];
    const residual = def.emit!.call([a, b], testCtx());
    expect(residual).toEqual(Method(Ref(Binding("Math")), "trunc", [Bin("/", a, b)]));
  });

  it("quotient: a mis-arity call doors (totality — never a silent miscompile)", () => {
    const def = nativeDef("quotient");
    expect(() => def.emit!.call([ref("a")], testCtx())).toThrow(/wants exactly 2 arguments/);
    expect(() => def.emit!.call([ref("a"), ref("b"), ref("c")], testCtx())).toThrow(/wants exactly 2 arguments/);
  });

  it("modulo: the Contract carries the emit rule; call builds ((a % n) + n) % n", () => {
    const def = nativeDef("modulo");
    expect(def.emit).toBeDefined();
    expect(def.narrows).toBeUndefined();
    const [a, n] = [ref("a"), ref("n")];
    const residual = def.emit!.call([a, n], testCtx());
    expect(residual).toEqual(Bin("%", Bin("+", Bin("%", a, n), n), n));
  });

  it("modulo: a mis-arity call doors", () => {
    const def = nativeDef("modulo");
    expect(() => def.emit!.call([ref("a")], testCtx())).toThrow(/wants exactly 2 arguments/);
  });

  it("= : the Contract carries the emit rule; 2-ary builds one Bin(===)", () => {
    const def = nativeDef("=");
    expect(def.emit).toBeDefined();
    expect(def.narrows).toBeUndefined(); // a value comparison narrows no type — not Law-N flagged
    const [a, b] = [ref("a"), ref("b")];
    expect(def.emit!.call([a, b], testCtx())).toEqual(Bin("===", a, b));
  });

  it("= : n-ary chains && over pairwise ===, natively correct under §7's one-number law", () => {
    const def = nativeDef("=");
    const [a, b, c] = [ref("a"), ref("b"), ref("c")];
    expect(def.emit!.call([a, b, c], testCtx())).toEqual(Bin("&&", Bin("===", a, b), Bin("===", b, c)));
  });

  it("= : a 0/1-ary call is vacuously true (R7RS degenerate case), never a door", () => {
    const def = nativeDef("=");
    expect(def.emit!.call([], testCtx())).toEqual(Lit(true));
    expect(def.emit!.call([ref("a")], testCtx())).toEqual(Lit(true));
  });
});

describe("numeric Contract.emit — the Phase-2 relocation drill (+ - * /)", () => {
  it("+ : (+) → 0, (+ a) → a bare (no operator node), (+ a b c) → flat left fold", () => {
    const def = nativeDef("+");
    expect(def.emit).toBeDefined();
    expect(def.narrows).toBeUndefined();
    const [a, b, c] = [ref("a"), ref("b"), ref("c")];
    expect(def.emit!.call([], testCtx())).toEqual(Lit(0));
    expect(def.emit!.call([a], testCtx())).toEqual(a);
    expect(def.emit!.call([a, b, c], testCtx())).toEqual(Bin("+", Bin("+", a, b), c));
  });

  it("* : (*) → 1, (* a) → a bare, (* a b) → Bin(*)", () => {
    const def = nativeDef("*");
    expect(def.emit).toBeDefined();
    const [a, b] = [ref("a"), ref("b")];
    expect(def.emit!.call([], testCtx())).toEqual(Lit(1));
    expect(def.emit!.call([a], testCtx())).toEqual(a);
    expect(def.emit!.call([a, b], testCtx())).toEqual(Bin("*", a, b));
  });

  it("- : unary negates (Un), n-ary left-folds, nullary doors", () => {
    const def = nativeDef("-");
    expect(def.emit).toBeDefined();
    const [a, b, c] = [ref("a"), ref("b"), ref("c")];
    expect(def.emit!.call([a], testCtx())).toEqual(Un("-", a));
    expect(def.emit!.call([a, b, c], testCtx())).toEqual(Bin("-", Bin("-", a, b), c));
    expect(() => def.emit!.call([], testCtx())).toThrow(/wants at least 1 argument/);
  });

  it("/ : unary is the R7RS reciprocal (1 / x), n-ary left-folds, nullary doors", () => {
    const def = nativeDef("/");
    expect(def.emit).toBeDefined();
    const [a, b] = [ref("a"), ref("b")];
    expect(def.emit!.call([a], testCtx())).toEqual(Bin("/", Lit(1), a));
    expect(def.emit!.call([a, b], testCtx())).toEqual(Bin("/", a, b));
    expect(() => def.emit!.call([], testCtx())).toThrow(/wants at least 1 argument/);
  });
});

describe("numeric Contract.emit — fact-gated relocation (< <= > >=)", () => {
  it('< : both operands proven numeric, 2-ary → Bin("<", a, b) (Law A soundness: nil is excluded by the numeric fact)', () => {
    const def = nativeDef("<");
    expect(def.emit).toBeDefined();
    expect(def.narrows).toBeUndefined(); // not a Law-N narrowing leaf
    const [a, b] = [ref("a"), ref("b")];
    const residual = def.emit!.call([a, b], testCtx({ argFacts: [{ numeric: true }, { numeric: true }] }));
    expect(residual).toEqual(Bin("<", a, b));
  });

  it("< : n-ary, ALL operands proven numeric → a<b && b<c (middle operand double-evaluated, mirrors numEqEmitRule)", () => {
    const def = nativeDef("<");
    const [a, b, c] = [ref("a"), ref("b"), ref("c")];
    const residual = def.emit!.call(
      [a, b, c],
      testCtx({ argFacts: [{ numeric: true }, { numeric: true }, { numeric: true }] }),
    );
    expect(residual).toEqual(Bin("&&", Bin("<", a, b), Bin("<", b, c)));
  });

  it("< : no facts (Law F) → the runtime looseCompare(wrapOrd(...)) shim, never a bare JS <", () => {
    const def = nativeDef("<");
    const [a, b] = [ref("a"), ref("b")];
    const residual = def.emit!.call([a, b], testCtx({ runtime: (name) => Ref(Binding(`__runtime_${name}`)) }));
    expect(residual).toEqual(Call(Ref(Binding("__runtime_<")), [a, b]));
  });

  it("< : ONE operand proven numeric but not the other → still the shim (all-or-nothing over the whole call, never a partial chain)", () => {
    const def = nativeDef("<");
    const [a, b] = [ref("a"), ref("b")];
    const residual = def.emit!.call(
      [a, b],
      testCtx({ argFacts: [{ numeric: true }, {}], runtime: (name) => Ref(Binding(`__runtime_${name}`)) }),
    );
    expect(residual).toEqual(Call(Ref(Binding("__runtime_<")), [a, b]));
  });

  it("< : a nil-tolerance row — an UNPROVEN operand that is nil at runtime still routes through the shim (the shim's own nilOrderCompare handles it; the emit rule never assumes numeric on an unproven fact)", () => {
    const def = nativeDef("<");
    const [a, b] = [ref("a"), ref("b")];
    // No fact says `b` excludes nil — Law F's conservative branch fires regardless of
    // what `a` proves, so a nil `b` at runtime is still correctly routed to the
    // nil-tolerant shim rather than a bare JS `<` that would coerce nil to NaN/0.
    const residual = def.emit!.call(
      [a, b],
      testCtx({ argFacts: [{ numeric: true }, {}], runtime: (name) => Ref(Binding(`__runtime_${name}`)) }),
    );
    expect(residual).toEqual(Call(Ref(Binding("__runtime_<")), [a, b]));
  });

  it("< : a 0/1-ary call is vacuously true (R7RS degenerate case), never a door", () => {
    const def = nativeDef("<");
    expect(def.emit!.call([], testCtx())).toEqual(Lit(true));
    expect(def.emit!.call([ref("a")], testCtx())).toEqual(Lit(true));
  });

  it('<= : proven → Bin("<=", a, b); unproven → the shim', () => {
    const def = nativeDef("<=");
    expect(def.emit).toBeDefined();
    const [a, b] = [ref("a"), ref("b")];
    expect(def.emit!.call([a, b], testCtx({ argFacts: [{ numeric: true }, { numeric: true }] }))).toEqual(
      Bin("<=", a, b),
    );
    expect(def.emit!.call([a, b], testCtx({ runtime: (name) => Ref(Binding(`__runtime_${name}`)) }))).toEqual(
      Call(Ref(Binding("__runtime_<=")), [a, b]),
    );
  });

  it('> : proven → Bin(">", a, b); unproven → the shim', () => {
    const def = nativeDef(">");
    expect(def.emit).toBeDefined();
    const [a, b] = [ref("a"), ref("b")];
    expect(def.emit!.call([a, b], testCtx({ argFacts: [{ numeric: true }, { numeric: true }] }))).toEqual(
      Bin(">", a, b),
    );
    expect(def.emit!.call([a, b], testCtx({ runtime: (name) => Ref(Binding(`__runtime_${name}`)) }))).toEqual(
      Call(Ref(Binding("__runtime_>")), [a, b]),
    );
  });

  it('>= : proven → Bin(">=", a, b); unproven → the shim', () => {
    const def = nativeDef(">=");
    expect(def.emit).toBeDefined();
    const [a, b] = [ref("a"), ref("b")];
    expect(def.emit!.call([a, b], testCtx({ argFacts: [{ numeric: true }, { numeric: true }] }))).toEqual(
      Bin(">=", a, b),
    );
    expect(def.emit!.call([a, b], testCtx({ runtime: (name) => Ref(Binding(`__runtime_${name}`)) }))).toEqual(
      Call(Ref(Binding("__runtime_>=")), [a, b]),
    );
  });
});

describe("numeric Contract.emit — fact-gated relocation (zero?)", () => {
  it('zero?: proven numeric → Bin("===", n, Lit(0))', () => {
    const def = nativeDef("zero?");
    expect(def.emit).toBeDefined();
    expect(def.narrows).toBeUndefined();
    const n = ref("n");
    expect(def.emit!.call([n], testCtx({ argFacts: [{ numeric: true }] }))).toEqual(Bin("===", n, Lit(0)));
  });

  it("zero?: no facts (Law F) → the runtime shim, never a bare === 0", () => {
    const def = nativeDef("zero?");
    const n = ref("n");
    const residual = def.emit!.call([n], testCtx({ runtime: (name) => Ref(Binding(`__runtime_${name}`)) }));
    expect(residual).toEqual(Call(Ref(Binding("__runtime_zero?")), [n]));
  });

  it("zero?: a mis-arity call doors (totality — never a silent miscompile)", () => {
    const def = nativeDef("zero?");
    expect(() => def.emit!.call([], testCtx())).toThrow(/wants exactly 1 argument/);
    expect(() => def.emit!.call([ref("a"), ref("b")], testCtx())).toThrow(/wants exactly 1 argument/);
  });
});
