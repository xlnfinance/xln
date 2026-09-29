// bind is absent from AmbientRuntime's type; public LexicalScope.env does not
// type it. The write face is LexicalScopeWithInternals / EnvWithInternals —
// an extension of the declaration, fused at the definition that intends to write.
import { describe, expectTypeOf, test } from "vitest";
import type { EnvWithInternals, LexicalScopeInternals } from "../env/AmbientRuntime.js";
import { AmbientRuntime, ResolvingAmbient } from "../env/AmbientRuntime.js";
import { LexicalScope, type LexicalScopeWithInternals } from "../eval/LexicalScope.js";
import type { Resolver } from "../eval/Resolver.js";

describe("privileged bind face", () => {
  test("AmbientRuntime.bind is not public", () => {
    const env = AmbientRuntime.root("pin");
    expectTypeOf(env).not.toHaveProperty("bind");
  });

  test("LexicalScope.env.bind is not public", () => {
    const scope = LexicalScope.fresh("pin");
    expectTypeOf(scope.env).not.toHaveProperty("bind");
  });

  test("LexicalScopeWithInternals.env.bind is callable", () => {
    expectTypeOf<LexicalScopeWithInternals["env"]["bind"]>().toBeFunction();
    expectTypeOf<LexicalScopeWithInternals<Resolver>["env"]["bind"]>().toBeFunction();
  });

  test("EnvWithInternals.bind is callable", () => {
    expectTypeOf<EnvWithInternals["bind"]>().toBeFunction();
    expectTypeOf<EnvWithInternals<ResolvingAmbient>["bind"]>().toBeFunction();
  });

  test("LexicalScopeInternals is the env write face", () => {
    expectTypeOf<LexicalScopeInternals["env"]["bind"]>().toBeFunction();
  });
});
