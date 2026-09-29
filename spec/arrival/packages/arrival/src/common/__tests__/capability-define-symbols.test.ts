// capability-define-symbols.test.ts — Stage 1c (docs/execution.md §CALLCTX): the FLIPPED
// authoring API, `EnvCapability.define`. Mirrors `callctx-activation-dispatch.test.ts`'s own
// proof for the OLD authoring style — this is the NEW style's parallel, exercised through a
// REAL evaluator dispatch (`exec()`, the actual `evaluatePair` path), not a synthetic
// direct-apply that would bypass the wiring under test.
//
// The `symbols: (symbol, z) => {...}` callback below receives the injected factory pair with
// ZERO explicit type annotations or casts inside the impl — `this.configuration`/
// `this.resources` are inferred contextually as the capability's OWN declared `Config`/
// `Resources` (the load-bearing proof `ImplThis`/`RosettaTag` exist for). The second `it` below
// is a NEGATIVE assertion: a mistyped `this.configuration.<key>` must fail to typecheck.
//
// CONFIGURATION RELOCATION: `this.configuration` (and the `resources` factory it feeds, below)
// now resolves off the RUN's `capabilityConfigurations` table, filled at `instantiate()` from
// the ambient a run assembled — never from the bind-time association. The dispatch `it` below
// exercises the sanctioned `exec(code, { capabilities, config })` ambient path rather than a
// manual `capability.lower(...).apply(env, ...)` + `exec(code, { env })` bind-then-glass-exec,
// which would now see `this.configuration === undefined` (documented in `run/RunContext.ts`'s
// `capabilityConfigurations` field doc) — the SAME posture a resource-less capability already
// has, and the same one `callctx-activation-dispatch.test.ts` documents at its own header.
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { EnvCapability } from "../capability.js";
import { exec } from "../../eval/generator-exec.js";

interface Shout {
  shout(s: string): string;
}

// THE API UNDER TEST — `EnvCapability.define`, COEXISTING with `new EnvCapability(...)`
// (`callctx-activation-dispatch.test.ts` still exercises that path unchanged).
const greeter = EnvCapability.define("test/define-greeter", {
  configuration: { key: z.string() },
  resources: (config): Shout => ({ shout: (s: string) => `${config.key}:${s.toUpperCase()}` }),
  symbols: (symbol, sz) => ({
    greet: symbol.rosetta`greet: typed this.configuration/this.resources via EnvCapability.define`(
      { input: [sz.string], output: [sz.string] },
      function (s: string) {
        // Both channels read off `this` with no annotation anywhere in this impl — the
        // injected `symbol.rosetta`'s `this` is `ImplThis<{key: string}, Shout>`, inferred
        // purely from `greeter`'s own `configuration`/`resources` declarations above.
        void this.configuration.key;
        return this.resources.shout(s);
      },
    ),
  }),
});

describe("EnvCapability.define (Stage 1c)", () => {
  it("threads typed configuration + resources onto `this` at real evaluator dispatch", async () => {
    const [out] = await exec('(greet "yo")', { capabilities: [greeter], config: { key: "hi" } });
    expect(out).toBe("hi:YO");
  });

  // NEGATIVE ASSERTION (mirrors `symbol.test.ts`'s own "a wrong-typed … impl is a compile
  // error" cases) — a mistyped `this.configuration.<unknown key>` must fail to typecheck,
  // proving the inference actually narrows `this` instead of silently widening to `any`.
  it("a mistyped this.configuration property is a compile error", () => {
    EnvCapability.define("test/define-greeter-bad", {
      configuration: { key: z.string() },
      resources: (config): Shout => ({ shout: (s: string) => `${config.key}:${s.toUpperCase()}` }),
      symbols: (symbol, sz) => ({
        greet: symbol.rosetta`greet: negative assertion only, never invoked`(
          { input: [sz.string], output: [sz.string] },
          function (s: string) {
            // @ts-expect-error — "wrong" does not exist on `configuration` (only "key" does).
            void this.configuration.wrong;
            return this.resources.shout(s);
          },
        ),
      }),
    });
    expect(true).toBe(true);
  });
});
