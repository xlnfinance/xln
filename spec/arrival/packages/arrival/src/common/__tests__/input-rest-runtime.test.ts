// input-rest-runtime.test.ts — RED-then-GREEN spec for `Contract.inputRest`: a FIXED
// leading `input` tuple plus a separately-typed variadic TAIL (its own generic type
// parameter — see `_bake.ts`'s `RestSpec`/`DecodedArgsWithRest`). The type-level proofs
// live in `src/__tests__/symbol.test-d.ts`; THIS file proves the RUNTIME decode path
// (bakeRosetta) actually splits a variable-length real scheme argument list into the
// fixed head + variadic tail and decodes each side through its OWN codec — inputRest
// isn't just a type-level fiction, it has to decode right at runtime too.
//
// Two planes, mirroring kwargs-runtime.test.ts's convention (the closest prior art for
// "wire a new Contract-level splitting concept into bakeRosetta's decode step"):
//   • UNIT (direct `def.run(...)`) — proves the decode membrane in isolation, no evaluator.
//   • INTEGRATION (`exec` over a real capability-assembled env) — proves the scheme-level
//     call `(tool head r1 r2 …)` reaches the impl as a decoded fixed-head + variadic-tail,
//     end to end.
//
// Absent `inputRest`, behavior is untouched — see capability-rosetta-symbol.test.ts's
// existing suite for that byte-identical-when-absent coverage; this file is additive-only.

import { describe, expect, it, beforeAll } from "vitest";
import type { ResolvingAmbient } from "../../env/AmbientRuntime.js";
import { execStateOverFrame as execState } from "../../eval/generator-exec.js";
import { applyCapability, freshEnv } from "../../__tests__/_fresh-env.js";
import { CONSTANT_CTX } from "../../run/RunContext.js";
import { AString } from "../../values/primitives/AString.js";
import { AInexact } from "../../values/primitives/AInexact.js";
import { symbol } from "../../symbol/index.js";
import { testCallCtx } from "../../run/CallCtx.js";
import { normalizeInputVector } from "../symbols/_bake.js";
import * as z from "../scheme-zod/index.js";
import { EnvCapability } from "../capability.js";

/** Invoke a baked rosetta procedure via its apply term (the sole membrane spine). */
function fire(proc: { ["arrival/tagless-final/apply"](args: any[], callCtx: any): any }, callCtx: any, ...args: any[]) {
  return proc["arrival/tagless-final/apply"](args, callCtx);
}

describe("Contract.inputRest runtime — UNIT (direct def.run): a fixed head + variadic tail", () => {
  it("decodes a FIXED head + a 0-length variadic tail", async () => {
    const def = symbol.rosetta`headtail0: report head + tail`(
      { input: [z.string], inputRest: z.number, output: [z.string] },
      (head: string, ...rest: number[]) => `${head}:${rest.length}:${rest.join(",")}`,
    );
    const out = await fire(def, testCallCtx(), new AString("h"));
    expect((out as AString)["arrival/toJS"]()).toBe("h:0:");
  });

  it("decodes a FIXED head + a 2-element variadic tail, each element through inputRest's OWN codec", async () => {
    const def = symbol.rosetta`headtail2: report head + tail`(
      { input: [z.string], inputRest: z.number, output: [z.string] },
      (head: string, ...rest: number[]) => `${head}:${rest.length}:${rest.join(",")}`,
    );
    const out = await fire(def, testCallCtx(), new AString("h"), new AInexact(1), new AInexact(2));
    expect((out as AString)["arrival/toJS"]()).toBe("h:2:1,2");
  });

  it("a DIFFERENT arity again (3-element tail) — proves the split is genuinely variadic, not a fixed 2-slot", async () => {
    const def = symbol.rosetta`headtail3: report head + tail`(
      { input: [z.string], inputRest: z.number, output: [z.string] },
      (head: string, ...rest: number[]) => `${head}:${rest.length}:${rest.join(",")}`,
    );
    const out = await fire(def, testCallCtx(), new AString("h"), new AInexact(1), new AInexact(2), new AInexact(3));
    expect((out as AString)["arrival/toJS"]()).toBe("h:3:1,2,3");
  });
});

describe("Contract.inputRest runtime — INTEGRATION ((tool head r1 r2 …) through a real env + exec)", () => {
  let env: ResolvingAmbient;
  beforeAll(async () => {
    env = await freshEnv();
    const headtail = symbol.rosetta`headtail: report head + tail`(
      { input: [z.string], inputRest: z.number, output: [z.string] },
      (head: string, ...rest: number[]) => `${head}:${rest.length}:${rest.join(",")}`,
    );
    // Wired through the REAL EnvCapability binder (post-B2 binder cut: the "rosetta" kind
    // binds an ARosettaProcedure, not a bare fn) rather than a raw `env.set(name, def.run)`
    // bare-fn bypass — the ledger's "bare-fn env.set harness wiring" row (replacedBy:
    // "EnvCapability-wired fixtures") retires with this fixture.
    await applyCapability(env, [EnvCapability.define("test/input-rest-runtime", { symbols: () => ({ headtail }) })]);
  });

  it('(headtail "h") — 0-length tail through a real exec', async () => {
    // execState (COMPLEX tier): calls the `arrival/toJS` protocol method directly —
    // a boxed-state concern (RULINGS.md R1).
    const [out] = (await execState(`(headtail "h")`, { env })).values;
    expect((out as AString)["arrival/toJS"]()).toBe("h:0:");
  });

  it('(headtail "h" 1 2) — 2-element tail through a real exec', async () => {
    const [out] = (await execState(`(headtail "h" 1 2)`, { env })).values;
    expect((out as AString)["arrival/toJS"]()).toBe("h:2:1,2");
  });
});

describe("Contract.inputRest runtime — bake-time GUARD: inputRest requires a fixed tuple `input`", () => {
  it("throws when inputRest is combined with a NON-tuple (bare single-schema) input — contract-authoring error, not a silent ignore", () => {
    expect(() => normalizeInputVector(z.array(z.schemeValue), z.schemeValue)).toThrow(/fixed positional tuple/);
  });
});
