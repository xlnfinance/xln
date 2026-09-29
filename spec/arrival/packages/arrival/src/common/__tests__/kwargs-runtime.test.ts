// kwargs-runtime.test.ts — RED-then-GREEN spec for wiring `z.kwargs` runtime execution
// into arrival core (V's directive: reverse G8 — `z.kwargs` stops being TYPE-LAYER-only
// and works IN SCHEME at runtime, wired directly into `_bake.ts`'s shared machinery).
//
// THE READER/RESOLVER FINDING (established before writing this spec, so the runtime
// representation is honest, not guessed):
//   • the READER does NOT special-case `:` at all — `:a` lexes as a plain SYMBOL atom via
//     Lexer.ts's generic `_symbol_rules` (no keyword token class exists).
//   • a `:`-prefixed symbol is SELF-EVALUATING (keyword-tagless-apply.md): `Resolver.resolve`/
//     `env_get` (eval/Resolver.ts) return the `ASymbol` itself, no synthesized accessor.
//   • so by the time a call's ARGS reach a rosetta `run` wrapper, `(tool :a "x" :b 5)` has
//     ALREADY evaluated to `[:a, AString("x"), :b, AExact(5)]` (real `ASymbol`s) — the EXACT
//     interleaved shape the existing `dict` native op already folds into `{a:…, b:…}`
//     (env/polyglot/polyglot.ts). A kwargs rosetta reuses that SAME fold, just landing on a
//     validated+decoded object instead of a raw dict.
//
// Two planes, mirroring symbol.test.ts / capability-rosetta-symbol.test.ts's convention:
//   • UNIT (direct `def.run(...)`) — proves the decode membrane in isolation, manually
//     constructing the keyword symbols (no evaluator needed).
//   • INTEGRATION (`exec` over a real capability-assembled env) — proves the SCHEME-LEVEL
//     call `(tool :a v :b v2)` reaches the impl as one decoded object, end to end.

import { describe, expect, it, beforeAll } from "vitest";
import type { ResolvingAmbient } from "../../env/AmbientRuntime.js";
import { execOverFrame as exec, execStateOverFrame as execState } from "../../eval/generator-exec.js";
import { applyCapability, freshEnv } from "../../__tests__/_fresh-env.js";
import { CONSTANT_CTX } from "../../run/RunContext.js";
import { AString } from "../../values/primitives/AString.js";
import { AExact } from "../../values/primitives/AExact.js";
import { ASymbol } from "../../values/primitives/ASymbol.js";
import { symbol } from "../../symbol/index.js";
import { testCallCtx } from "../../run/CallCtx.js";
import * as z from "../scheme-zod/index.js";
import { EnvCapability } from "../capability.js";

/** Build a keyword `ASymbol` exactly as evaluating `:key` now does (self-evaluating —
 *  keyword-tagless-apply.md), for the UNIT plane (no evaluator round trip). */
function pluck(key: string): unknown {
  return new ASymbol(`:${key}`);
}

/** Invoke a baked rosetta procedure via its apply term (the sole membrane spine). */
function fire(proc: { ["arrival/tagless-final/apply"](args: any[], callCtx: any): any }, callCtx: any, ...args: any[]) {
  return proc["arrival/tagless-final/apply"](args, callCtx);
}

describe("z.kwargs runtime — UNIT (direct def.run, manually-built pluck pairs)", () => {
  it("decodes interleaved :key/value pairs into ONE constructed object arg", async () => {
    const def = symbol.rosetta`greet: kwargs greeting`(
      { input: [], inputRest: { a: z.string, b: z.number.optional() }, output: [z.string] },
      (args) => `${args.a}:${args.b}`,
    );
    const out = await fire(def, testCallCtx(), pluck("a"), new AString("Ada"), pluck("b"), new AExact(5));
    expect((out as AString)["arrival/toJS"]()).toBe("Ada:5");
  });

  it("keyword ORDER is independent of the shape's declared order", async () => {
    const def = symbol.rosetta`greet: kwargs greeting`(
      { input: [], inputRest: { a: z.string, b: z.number.optional() }, output: [z.string] },
      (args) => `${args.a}:${args.b}`,
    );
    const out = await fire(def, testCallCtx(), pluck("b"), new AExact(5), pluck("a"), new AString("Ada"));
    // NOTE: pairs must stay `:key value` (key first) — this call shows the TWO PAIRS in
    // swapped ORDER (the `:b` pair before the `:a` pair), not a swapped key/value.
    expect((out as AString)["arrival/toJS"]()).toBe("Ada:5");
  });
});

describe("z.kwargs runtime — INTEGRATION ((tool :k v …) through a real env + exec)", () => {
  let env: ResolvingAmbient;
  beforeAll(async () => {
    env = await freshEnv();
    // Record key must match the value's own mint-time name (Stage A2's
    // SymbolKeyMismatchError, common/capability.ts) — "kw-greet" both ways.
    const greet = symbol.rosetta`kw-greet: kwargs greeting`(
      { input: [], inputRest: { a: z.string, b: z.number.optional() }, output: [z.string] },
      (args) => `${args.a}:${args.b}`,
    );
    // Wired through the REAL EnvCapability binder (post-B2 binder cut: the "rosetta" kind
    // binds an ARosettaProcedure, not a bare fn) rather than a raw `env.set(name, def.run)`
    // bare-fn bypass — the ledger's "bare-fn env.set harness wiring" row (replacedBy:
    // "EnvCapability-wired fixtures") retires with this fixture.
    await applyCapability(env, [
      EnvCapability.define("test/kwargs-runtime", { symbols: () => ({ "kw-greet": greet }) }),
    ]);
  });

  it("(tool :a v :b v2) invokes the impl with the constructed {a,b} object", async () => {
    // execState (COMPLEX tier): calls the `arrival/toJS` protocol method directly —
    // a boxed-state concern (RULINGS.md R1).
    const [out] = (await execState(`(kw-greet :a "Ada" :b 5)`, { env })).values;
    expect((out as AString)["arrival/toJS"]()).toBe("Ada:5");
  });

  it("keyword ORDER at the call site is independent of the shape's declared order", async () => {
    const [out] = (await execState(`(kw-greet :b 5 :a "Ada")`, { env })).values;
    expect((out as AString)["arrival/toJS"]()).toBe("Ada:5");
  });

  it("an optional kwarg omitted leaves it undefined, no decode failure", async () => {
    const [out] = (await execState(`(kw-greet :a "Ada")`, { env })).values;
    expect((out as AString)["arrival/toJS"]()).toBe("Ada:undefined");
  });

  it(
    "a required kwarg missing DOORS cleanly — a per-FIELD validation error (path incl. :a), not the " +
      'pre-fix cryptic "expected object, received array" mismatch',
    async () => {
      // A missing required kwarg must name the field (kwargs humanizer,
      // common/kwargs-rejection.ts, args-error-reporting-v2.md §2.5).
      await expect(exec(`(kw-greet)`, { env })).rejects.toThrow(/:a — missing \(required\)/);
    },
  );
});
