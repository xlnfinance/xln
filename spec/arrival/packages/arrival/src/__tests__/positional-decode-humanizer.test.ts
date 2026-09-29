// B4 (the manifold benchmark-defect register, private monorepo docs) — a
// POSITIONAL/variadic `symbol.rosetta` verb's decode gate (`common/symbols/rosetta.ts`)
// used to let a raw `ZodError` propagate. zod v4's `ZodError.message` IS the
// pretty-printed JSON of `.issues` — a 25-line nested-union dump naming no verb and no
// argument. One model in the 89x2 benchmark corpus misread that dump as an invented
// `:limit max 500` schema constraint and voluntarily shrank its dataset 388→80, losing
// the task.
//
// Fix: `common/symbols/positional-rejection.ts` (this arm's own sibling of
// kwargs-rejection.ts's `issueLines`, keyed on ARG INDEX not kwarg NAME), wired into
// rosetta.ts's positional decode arm via try/catch(ZodError).
//
// Probe verb is a local rosetta (not a stdlib name): the gate is about decode
// humanization, not any particular R7RS/SRFI binding.
import { describe, expect, it } from "vitest";
import { exec } from "../eval/generator-exec.js";
import { EnvCapability } from "../common/capability.js";

const probe = EnvCapability.define("test/positional-decode-probe", {
  symbols: (symbol, z) => ({
    "probe-join": symbol.rosetta`probe-join: concatenate two strings (test probe for positional decode humanization)`(
      { input: [z.string, z.string], output: [z.string] },
      (a: string, b: string) => a + b,
    ),
  }),
});

const run = (code: string) => exec(code, { capabilities: [probe] });

describe("B4 — a positional decode rejection is humanized, not a raw ZodError dump", () => {
  it('(probe-join "a" 5) names the verb and the offending arg position', async () => {
    await expect(run('(probe-join "a" 5)')).rejects.toThrow(/probe-join/);
    await expect(run('(probe-join "a" 5)')).rejects.toThrow(/arg 2/);
  });

  it('(probe-join "a" 5) message does NOT contain the raw zod issues JSON', async () => {
    try {
      await run('(probe-join "a" 5)');
      throw new Error("expected probe-join to throw, it didn't");
    } catch (e) {
      const message = (e as Error).message;
      expect(message).not.toMatch(/"code"/);
      expect(message).not.toMatch(/invalid_union/);
      expect(message).not.toMatch(/invalid_type/);
    }
  });
});
