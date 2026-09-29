// symbol.alias — dissolution-semantics duplicate binding (arrival-mcp-extended-capability.md
// ruling 4). Two planes, mirroring input-rest-runtime.test.ts's convention:
//   • INTEGRATION (`exec` over a real capability-assembled env) — proves an alias resolves to
//     the SAME baked symbol under a new name, end to end.
//   • BAKE/ASSEMBLY GUARD — a target absent from the SAME capability's own `symbols` record
//     doors loudly (errors-as-doors) rather than silently binding nothing; so does aliasing
//     another alias (no chains).

import { describe, expect, it, beforeAll } from "vitest";
import type { ResolvingAmbient } from "../../env/AmbientRuntime.js";
import { execStateOverFrame as execState } from "../../eval/generator-exec.js";
import { applyCapability, freshEnv } from "../../__tests__/_fresh-env.js";
import { AString } from "../../values/primitives/AString.js";
import { AInexact } from "../../values/primitives/AInexact.js";
import { EnvCapability } from "../capability.js";

describe("symbol.alias — resolves to the SAME symbol under a new name", () => {
  let env: ResolvingAmbient;
  beforeAll(async () => {
    env = await freshEnv();
    await applyCapability(env, [
      EnvCapability.define("test/alias-basic", {
        symbols: (symbol, z) => ({
          shout: symbol.rosetta`shout: upcase a string`({ input: [z.string], output: [z.string] }, (s) =>
            s.toUpperCase(),
          ),
          yell: symbol.alias`shout`,
        }),
      }),
    ]);
  });

  it("the alias's new name calls through to the target's real impl", async () => {
    const [out] = (await execState(`(yell "hi")`, { env })).values;
    expect((out as AString)["arrival/toJS"]()).toBe("HI");
  });

  it("the target's own name still works unchanged", async () => {
    const [out] = (await execState(`(shout "still here")`, { env })).values;
    expect((out as AString)["arrival/toJS"]()).toBe("STILL HERE");
  });

  // Each bound name gets its OWN freshly-constructed ARosettaProcedure (it carries its own
  // bound `name`), but the underlying `contract` (the baked def itself) is the SAME object
  // by reference — the dissolution semantics: never a wrapper, never a second impl.
  it("both names bind the SAME baked def by reference (byte-equivalent runtime)", () => {
    const yell = env.get("yell") as { contract: unknown };
    const shout = env.get("shout") as { contract: unknown };
    expect(yell.contract).toBe(shout.contract);
  });
});

describe("symbol.alias — numeric args flow through the target's own codecs", () => {
  it("an alias to a rosetta verb decodes/encodes exactly like the target", async () => {
    const env2 = await freshEnv();
    await applyCapability(env2, [
      EnvCapability.define("test/alias-numeric", {
        symbols: (symbol, z) => ({
          inc: symbol.rosetta`inc: add one`({ input: [z.number], output: [z.number] }, (n) => n + 1),
          "inc-alias": symbol.alias`inc`,
        }),
      }),
    ]);
    const [out] = (await execState(`(inc-alias 41)`, { env: env2 })).values;
    expect((out as AInexact).real).toBe(42);
  });
});

describe("symbol.alias — bake/assembly errors (errors-as-doors, teaching text)", () => {
  it("a target absent from the SAME capability's own `symbols` record doors at assembly", async () => {
    const env3 = await freshEnv();
    const cap = EnvCapability.define("test/alias-missing-target", {
      symbols: (symbol) => ({ ghost: symbol.alias`does-not-exist` }),
    });
    let caught: unknown;
    try {
      await applyCapability(env3, [cap]);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toMatch(/does-not-exist/);
    expect((caught as Error).message).toMatch(/not declared in this capability's own `symbols` record/);
  });

  it("aliasing another alias (a chain) doors — alias directly to the real symbol", async () => {
    const env4 = await freshEnv();
    const cap = EnvCapability.define("test/alias-chain", {
      symbols: (symbol, z) => ({
        orig: symbol.rosetta`orig: identity`({ input: [z.string], output: [z.string] }, (s) => s),
        first: symbol.alias`orig`,
        second: symbol.alias`first`,
      }),
    });
    await expect(applyCapability(env4, [cap])).rejects.toThrow(/alias chains are not supported/);
  });
});
