// lists-emit.test.ts — Contract.emit on cons/map/apply (the Phase-2 relocation drill,
// the TS-transpiler constitution §9): proves
// each symbol's own Contract builds the residual-lite shape its `emit` rule owns, by
// calling `emit.call` directly against a synthetic EmitCtx. No compiler package, no
// oracle session, no `typescript` import — matching this whole subpath's own
// typescript-free discipline (§4.5). Mirrors numeric-emit.test.ts's own harness
// exactly (same `testCtx`/`nativeDef`/`ref` shape) — see that file for the fuller
// rationale comment.
//
// map/apply's residual shapes are still BYTE-PARITY with the PRE-relocation
// compiler-side table rule (proven on the mercury side, inhuman/foundations/
// arrival-mercury: rules-phase1.test.ts's own "map"/"apply" (Wave 3) goldens moved
// to this file's Contract-level proof once their table rows were deleted). cons's
// shape is NOT byte-parity with its own pre-relocation table rule — its residual now
// depends on the tail argument's fact (see lists.ts's own `consEmitRule` section for
// why an unconditional shape was unsound). The cross-pass/gate3 goldens and bug-cell
// corpus exercise cons/map/apply through the REAL harvest + walker + render pipeline,
// unchanged.
import { describe, expect, it } from "vitest";

import type { AEntity } from "../../../common/symbols/_bake.js";
import type { EmitCtx } from "../../../emit/emit-rule.js";
import {
  ArrayLit,
  Arrow,
  Bin,
  Binding,
  Call,
  Index,
  Lit,
  Member,
  Method,
  Ref,
  Spread,
  type R,
} from "../../../emit/residual-lite.js";
import listsPack from "../lists.js";
import { harvestContracts } from "../../../__tests__/_symbols-harvest.js";

const symbols = harvestContracts(listsPack.spec.symbols);

function nativeDef(name: string) {
  const def = symbols[name];
  if (def === undefined) throw new Error(`lists pack: no symbol named ${name}`);
  if (def.kind !== "native") throw new Error(`lists pack: ${name} is not a native def (got ${def.kind})`);
  return def;
}

/** `map` is declared via `symbol.sequence` (not `symbol.native`) — its own def kind. */
function sequenceDef(name: string) {
  const def = symbols[name];
  if (def === undefined) throw new Error(`lists pack: no symbol named ${name}`);
  if (def.kind !== "sequence") throw new Error(`lists pack: ${name} is not a sequence def (got ${def.kind})`);
  return def;
}

/** A synthetic EmitCtx — no namer, no runtime module, no register bias (none of
 *  cons/map/apply ever branch on `config.register`). `door` throws — the SAME
 *  observable contract a real `ctx.door` has (a typed refusal, never a silent
 *  miss), so a mis-arity call is assertable via `toThrow`. `fresh` returns the
 *  hint AS the binding text (map/apply's own rules never inspect what `fresh`
 *  returns beyond wrapping it in `Ref`, so the test's own naming choice is the
 *  simplest one that makes assertions legible). `runtime` throws by default:
 *  map/apply never call it, and cons only does for an UNKNOWN tail fact (its
 *  proven-array / proven-scalar branches never reach it) — the one test
 *  exercising that branch overrides `runtime` explicitly. */
function testCtx(over: Partial<EmitCtx<R>> = {}): EmitCtx<R> {
  return {
    argFacts: [],
    config: { register: "run" },
    fresh: (hint) => Binding(hint),
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

/** apply's fold-recognition inspects an ALREADY-LOWERED argument's own `RuntimeRef`
 *  tag — residual-lite carries the ARM (see its own doc comment on the `R` union) but
 *  no constructor, since nothing in arrival core ever MINTS one (only the compiler's
 *  real walker does, when a shim-refPolicy symbol resolves in value position). This
 *  test-local helper builds the shape directly — the same "no constructor exists, so
 *  the test states the raw shape" convention residual-lite's own header documents. */
const runtimeRef = (symbol: string): R => ({ t: "RuntimeRef", symbol }) as R;

describe("lists Contract.emit — the Phase-2 relocation drill (cons)", () => {
  it("cons: the Contract carries the emit rule", () => {
    const def = nativeDef("cons");
    expect(def.emit).toBeDefined();
    expect(def.narrows).toBeUndefined(); // not a Law-N narrowing leaf
  });

  it("cons: tail PROVEN list/pair/nonEmptyList → the spread [x, ...xs] (the proper-list golden)", () => {
    const def = nativeDef("cons");
    const [x, xs] = [ref("x"), ref("xs")];
    for (const tailFact of [{ list: true }, { pair: true }, { nonEmptyList: true }] as const) {
      const residual = def.emit!.call([x, xs], testCtx({ argFacts: [{}, tailFact] }));
      expect(residual).toEqual(ArrayLit([x, Spread(xs)]));
    }
  });

  it("cons: tail PROVEN scalar (stringy/numeric/boolean) → the clean 2-element pair [x, xs], no spread (the alist-entry golden)", () => {
    const def = nativeDef("cons");
    const [k, v] = [ref("k"), ref("v")];
    for (const tailFact of [{ numeric: true }, { stringy: true }, { boolean: true }] as const) {
      const residual = def.emit!.call([k, v], testCtx({ argFacts: [{}, tailFact] }));
      expect(residual).toEqual(ArrayLit([k, v]));
    }
  });

  it("cons: tail UNKNOWN (no fact proven either way) → the runtime cons shim, never a bare spread", () => {
    const def = nativeDef("cons");
    const [x, xs] = [ref("x"), ref("xs")];
    const residual = def.emit!.call([x, xs], testCtx({ argFacts: [{}, {}], runtime: (name) => runtimeRef(name) }));
    expect(residual).toEqual(Call(runtimeRef("cons"), [x, xs]));
  });

  it("cons: a mis-arity call doors (totality — never a silent miscompile)", () => {
    const def = nativeDef("cons");
    expect(() => def.emit!.call([ref("x")], testCtx())).toThrow(/wants exactly 2 arguments/);
    expect(() => def.emit!.call([ref("x"), ref("xs"), ref("extra")], testCtx())).toThrow(/wants exactly 2 arguments/);
  });
});

describe("lists Contract.emit — the Phase-2 relocation drill (map — Wave 3)", () => {
  it("map: the Contract carries the emit rule; single-list → xs.map(f) bare", () => {
    const def = sequenceDef("map");
    expect(def.emit).toBeDefined();
    expect(def.narrows).toBeUndefined();
    const [f, xs] = [ref("f"), ref("xs")];
    expect(def.emit!.call([f, xs], testCtx())).toEqual(Method(xs, "map", [f]));
  });

  it("map: multi-list → the index-zip arrow (drives off lists[0])", () => {
    const def = sequenceDef("map");
    const [f, xs, ys] = [ref("f"), ref("xs"), ref("ys")];
    const residual = def.emit!.call([f, xs, ys], testCtx());
    const el = Binding("item");
    const idx = Binding("i");
    expect(residual).toEqual(Method(xs, "map", [Arrow([el, idx], Call(f, [Ref(el), Index(ys, Ref(idx))]))]));
  });

  it("map: three lists zip the same way", () => {
    const def = sequenceDef("map");
    const [f, xs, ys, zs] = [ref("f"), ref("xs"), ref("ys"), ref("zs")];
    const residual = def.emit!.call([f, xs, ys, zs], testCtx());
    const el = Binding("item");
    const idx = Binding("i");
    expect(residual).toEqual(
      Method(xs, "map", [Arrow([el, idx], Call(f, [Ref(el), Index(ys, Ref(idx)), Index(zs, Ref(idx))]))]),
    );
  });

  it("map: a sub-2-argument call doors (totality — never a silent miscompile)", () => {
    const def = sequenceDef("map");
    expect(() => def.emit!.call([ref("f")], testCtx())).toThrow(/wants a function and at least one list/);
  });
});

describe("lists Contract.emit — the Phase-2 relocation drill (apply — Wave 3)", () => {
  it("apply: (apply + xs) → xs.reduce((acc, item) => acc + item, 0) — the fold-recognition bridge", () => {
    const def = nativeDef("apply");
    expect(def.emit).toBeDefined();
    expect(def.narrows).toBeUndefined();
    const xs = ref("xs");
    const residual = def.emit!.call([runtimeRef("+"), xs], testCtx());
    const acc = Binding("acc");
    const item = Binding("item");
    expect(residual).toEqual(Method(xs, "reduce", [Arrow([acc, item], Bin("+", Ref(acc), Ref(item))), Lit(0)]));
  });

  it("apply: (apply * xs) → identity 1", () => {
    const def = nativeDef("apply");
    const xs = ref("xs");
    const residual = def.emit!.call([runtimeRef("*"), xs], testCtx());
    const acc = Binding("acc");
    const item = Binding("item");
    expect(residual).toEqual(Method(xs, "reduce", [Arrow([acc, item], Bin("*", Ref(acc), Ref(item))), Lit(1)]));
  });

  it("apply: (apply f xs) generic → spread f(...xs) (not f.apply(null, xs))", () => {
    const def = nativeDef("apply");
    const [f, xs] = [ref("f"), ref("xs")];
    expect(def.emit!.call([f, xs], testCtx())).toEqual(Call(f, [Spread(xs)]));
  });

  it("apply: leading fixed args compose: (apply f a xs) → f(a, ...xs)", () => {
    const def = nativeDef("apply");
    const [f, a, xs] = [ref("f"), ref("a"), ref("xs")];
    expect(def.emit!.call([f, a, xs], testCtx())).toEqual(Call(f, [a, Spread(xs)]));
  });

  it("apply: a same-shaped but non-RuntimeRef 2-ary call never fires the fold (Law A: keys on the residual's own tag, not a guess)", () => {
    const def = nativeDef("apply");
    const [f, xs] = [ref("f"), ref("xs")];
    expect(def.emit!.call([f, xs], testCtx())).toEqual(Call(f, [Spread(xs)]));
  });

  it("apply: a sub-2-argument call doors (totality — never a silent miscompile)", () => {
    const def = nativeDef("apply");
    expect(() => def.emit!.call([ref("f")], testCtx())).toThrow(/wants a function and a trailing argument list/);
  });
});

describe("lists Contract.emit — the SAME provesArray fact-gate as cons (length / list-ref)", () => {
  it("length: xs PROVEN array-backed (list/pair/nonEmptyList) → the clean xs.length member read", () => {
    const def = nativeDef("length");
    expect(def.emit).toBeDefined();
    expect(def.narrows).toBeUndefined(); // not a Law-N narrowing leaf
    const xs = ref("xs");
    for (const tailFact of [{ list: true }, { pair: true }, { nonEmptyList: true }] as const) {
      const residual = def.emit!.call([xs], testCtx({ argFacts: [tailFact] }));
      expect(residual).toEqual(Member(xs, "length"));
    }
  });

  it("length: xs UNKNOWN (no fact proven) → the runtime length shim, never a bare .length (the string/vector-carrier case)", () => {
    const def = nativeDef("length");
    const xs = ref("xs");
    const residual = def.emit!.call([xs], testCtx({ argFacts: [{}], runtime: (name) => runtimeRef(name) }));
    expect(residual).toEqual(Call(runtimeRef("length"), [xs]));
  });

  it("length: a mis-arity call doors", () => {
    const def = nativeDef("length");
    expect(() => def.emit!.call([], testCtx())).toThrow(/wants exactly 1 argument/);
    expect(() => def.emit!.call([ref("a"), ref("b")], testCtx())).toThrow(/wants exactly 1 argument/);
  });

  it("list-ref: xs PROVEN array-backed → the clean xs[k] index read", () => {
    const def = nativeDef("list-ref");
    expect(def.emit).toBeDefined();
    expect(def.narrows).toBeUndefined();
    const [xs, k] = [ref("xs"), ref("k")];
    for (const tailFact of [{ list: true }, { pair: true }, { nonEmptyList: true }] as const) {
      const residual = def.emit!.call([xs, k], testCtx({ argFacts: [tailFact, {}] }));
      expect(residual).toEqual(Index(xs, k));
    }
  });

  it("list-ref: xs UNKNOWN (no fact proven) → the runtime list-ref shim (spine-walk + OOB door), never a bare index", () => {
    const def = nativeDef("list-ref");
    const [xs, k] = [ref("xs"), ref("k")];
    const residual = def.emit!.call([xs, k], testCtx({ argFacts: [{}, {}], runtime: (name) => runtimeRef(name) }));
    expect(residual).toEqual(Call(runtimeRef("list-ref"), [xs, k]));
  });

  it("list-ref: the fact gate reads ONLY the list operand's fact (argFacts[0]), not the index's — an unproven index alongside a proven list still takes the clean path", () => {
    const def = nativeDef("list-ref");
    const [xs, k] = [ref("xs"), ref("k")];
    const residual = def.emit!.call([xs, k], testCtx({ argFacts: [{ list: true }] })); // argFacts[1] absent entirely
    expect(residual).toEqual(Index(xs, k));
  });

  it("list-ref: a mis-arity call doors", () => {
    const def = nativeDef("list-ref");
    expect(() => def.emit!.call([ref("xs")], testCtx())).toThrow(/wants exactly 2 arguments/);
    expect(() => def.emit!.call([ref("xs"), ref("k"), ref("extra")], testCtx())).toThrow(/wants exactly 2 arguments/);
  });
});
