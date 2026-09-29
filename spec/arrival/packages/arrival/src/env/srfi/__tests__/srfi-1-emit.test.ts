// srfi-1-emit.test.ts — Contract.emit on filter (the Phase-2 relocation drill,
// the TS-transpiler constitution §9): proves
// the rule logic relocated from the compiler-side phase1 table onto filter's own
// Contract builds the exact residual-lite shape the table rule used to build, by
// calling `emit.call` directly against a synthetic EmitCtx. No compiler package, no
// oracle session, no `typescript` import — matching this whole subpath's own
// typescript-free discipline (§4.5). Mirrors lists-emit.test.ts/numeric-emit.test.ts's
// own harness exactly (same `testCtx`/`sequenceDef`/`ref` shape).
//
// UNLIKE every other Phase-2 relocation, filter's compiler-side table row (phase1.ts's
// own `filterRule`) does NOT go away — `scheme/srfi-1` (this Contract's capability)
// is not part of the oracle's harvested ambient, so the table row stays the only
// reachable copy through the real pipeline (see phase1.ts's own relocation note for
// the full account). rules-phase1.test.ts's filter describe block therefore ALSO
// stays, proving the table-resident rule end-to-end through the real walker/render
// pipeline; this file proves the Contract-carried twin in isolation — both are
// byte-identical copies of the same logic, verified independently.
//
// NOT a callable-returnFacts fix (see srfi-1.ts's own doc comment on `filterEmitRule`
// for the full reasoning): the clean-branch fact check below (`argFacts[0]?.boolean`)
// reads a fact about the PREDICATE VALUE itself, which is never `BooleanLike` under
// today's TypeFacts vocabulary — so it is relocated verbatim, not fixed. This file
// still exercises it (Law F: absent facts take the conservative form; an explicitly
// pinned `{ boolean: true }` still takes the clean form, proving the branch itself is
// correctly wired even though nothing in the real pipeline populates that fact today).
import { describe, expect, it } from "vitest";

import type { AEntity } from "../../../common/symbols/_bake.js";
import type { EmitCtx } from "../../../emit/emit-rule.js";
import { Arrow, Bin, Binding, Call, Lit, Method, Ref, type R } from "../../../emit/residual-lite.js";
import srfi1Pack from "../srfi-1.js";
import { harvestContracts } from "../../../__tests__/_symbols-harvest.js";

const symbols = harvestContracts(srfi1Pack.spec.symbols);

/** `filter` is declared via `symbol.sequence` (not `symbol.native`) — its own def kind
 *  (matching lists.ts's `map`, the sibling HOF this rule is modeled after). */
function sequenceDef(name: string) {
  const def = symbols[name];
  if (def === undefined) throw new Error(`srfi-1 pack: no symbol named ${name}`);
  if (def.kind !== "sequence") throw new Error(`srfi-1 pack: ${name} is not a sequence def (got ${def.kind})`);
  return def;
}

/** A synthetic EmitCtx — `filter` reads `argFacts[0]`/`config.register` (Law F's
 *  fact-directed clean/conservative split) and mints ONE hygienic temp on the
 *  conservative path; `runtime` is never called (filter never emits a RuntimeRef).
 *  `fresh` returns the hint AS the binding text — the rule never inspects what
 *  `fresh` returns beyond wrapping it in `Ref`, so this is the simplest choice that
 *  keeps assertions legible. */
function testCtx(over: Partial<EmitCtx<R>> = {}): EmitCtx<R> {
  return {
    argFacts: [],
    config: { register: "run" },
    fresh: (hint) => Binding(hint),
    runtime: (name) => {
      throw new Error(`testCtx: runtime(${name}) not expected — filter never emits a RuntimeRef`);
    },
    door: (reason) => {
      throw new Error(reason);
    },
    ...over,
  };
}

const ref = (name: string): R => Ref(Binding(name));

describe("srfi-1 Contract.emit — the Phase-2 relocation drill (filter — Wave 3)", () => {
  it("filter: the Contract carries the emit rule; no facts → the Law-T guard (x) => pred(x) !== false", () => {
    const def = sequenceDef("filter");
    expect(def.emit).toBeDefined();
    expect(def.narrows).toBeUndefined(); // not a Law-N narrowing leaf
    const [pred, xs] = [ref("pred"), ref("xs")];
    const residual = def.emit!.call([pred, xs], testCtx());
    const x = Binding("x");
    expect(residual).toEqual(Method(xs, "filter", [Arrow([x], Bin("!==", Call(pred, [Ref(x)]), Lit(false)))]));
  });

  it("filter: argFacts[0].boolean on the predicate → bare .filter(pred)", () => {
    const def = sequenceDef("filter");
    const [pred, xs] = [ref("pred"), ref("xs")];
    const residual = def.emit!.call([pred, xs], testCtx({ argFacts: [{ boolean: true }] }));
    expect(residual).toEqual(Method(xs, "filter", [pred]));
  });

  it("filter: read register → bare .filter(pred) unconditionally (glass is never executed)", () => {
    const def = sequenceDef("filter");
    const [pred, xs] = [ref("pred"), ref("xs")];
    const residual = def.emit!.call([pred, xs], testCtx({ config: { register: "read" } }));
    expect(residual).toEqual(Method(xs, "filter", [pred]));
  });

  it("filter: a mis-arity call doors (totality — never a silent miscompile)", () => {
    const def = sequenceDef("filter");
    expect(() => def.emit!.call([ref("pred")], testCtx())).toThrow(/wants exactly 2 arguments/);
    expect(() => def.emit!.call([ref("pred"), ref("xs"), ref("extra")], testCtx())).toThrow(
      /wants exactly 2 arguments/,
    );
  });
});
