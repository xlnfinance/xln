import { CONSTANT_CTX } from "../../run/RunContext.js";
import type { EnvWithInternals, ResolvingAmbient } from "../../env/AmbientRuntime.js";
/**
 * Test all examples from the Quick Start section to ensure they work
 */
import { describe, expect, it } from "vitest";
import { jsToScheme, toJS } from "../../membrane/rosetta.js";
import { execOverFrame as exec, execStateOverFrame as execState } from "../../eval/generator-exec.js";
// In-package test: internal-module access (the barrel export retired — privatization V5).
import { inferenceEnv as sandboxedEnv } from "../../env/inference-env.js";
import { EnvCapability } from "../../common/capability.js";
import { applyCapability } from "../_fresh-env.js";

describe("Quick Start Examples", () => {
  it("Basic execution example", async () => {
    // execState (COMPLEX tier): toJS wants BOXED values — `exec` already unwraps.
    const { values: results } = await execState(
      `
  (filter (lambda (x) (> x 5))
    (list 1 3 7 9 2))
`,
      { env: sandboxedEnv },
    );

    expect(toJS(results[0], {})).toEqual([7, 9]);
  });

  it("Register custom functions with Rosetta", async () => {
    // Register a domain function via a test-local EnvCapability (`symbol.rosetta` —
    // `symbol.rosetta`. `z.list(z.number)` on both sides:
    // scheme proper-list ↔ JS `number[]`, decoded/encoded through the contract codecs
    // — JS arrays become Scheme lists automatically, same as the historical fixture.
    await applyCapability(sandboxedEnv, [
      EnvCapability.define("test/double-all", {
        symbols: (symbol, z) => ({
          "double-all": symbol.rosetta`double-all: doubles every element of a numeric list`(
            { input: [z.list(z.number)], output: [z.list(z.number)] },
            (numbers) => numbers.map((x) => x * 2),
          ),
        }),
      }),
    ]);

    // execState (COMPLEX tier): toJS wants BOXED values — `exec` already unwraps.
    const { values: results } = await execState(
      `
  (double-all (list 1 2 3 4 5))
`,
      { env: sandboxedEnv },
    );

    expect(toJS(results[0], {})).toEqual([2, 4, 6, 8, 10]);
  });

  it("Working with complex data", async () => {
    // Register function that filters objects — arbitrary-shaped JS data (an array of
    // `{id, priority}` records), so both slots stay `z.dynamic`. WORLD-FLIP REBASELINE
    // (ruling 2026-08-13): the impl converts its boxed INPUT itself (`toJS`) but returns
    // RAW JS — boxing the return is the membrane's job (an AValue return doors).
    await applyCapability(sandboxedEnv, [
      EnvCapability.define("test/high-priority-users", {
        symbols: (symbol, z) => ({
          "high-priority-users": symbol.rosetta`high-priority-users: filters users by priority`(
            { input: [z.dynamic], output: [z.dynamic] },
            (rawUsers) => {
              const users = toJS(rawUsers) as Array<{ id: string; priority: number }>;
              return users.filter((u) => u.priority > 10) as never;
            },
          ),
        }),
      }),
    ]);

    // Pass JS data to Scheme
    const users = [
      { id: "alice", priority: 15 },
      { id: "bob", priority: 5 },
      { id: "charlie", priority: 20 },
    ];

    (sandboxedEnv as EnvWithInternals<ResolvingAmbient>).bind("users", jsToScheme(CONSTANT_CTX, users, {}));

    // execState (COMPLEX tier): toJS wants BOXED values — `exec` already unwraps.
    const { values: results } = await execState(
      `
  (high-priority-users users)
`,
      { env: sandboxedEnv },
    );

    const result = toJS(results[0], {});
    expect(result).toEqual([
      { id: "alice", priority: 15 },
      { id: "charlie", priority: 20 },
    ]);
  });
});
