// vector-map / vector-for-each / string-map / string-for-each must settle
// async procs — a raw Promise in the result is a leak.
import { describe, expect, it } from "vitest";
import type { EnvWithInternals, ResolvingAmbient } from "../env/AmbientRuntime.js";
import { freshEnv } from "./_fresh-env.js";
import { execStateOverFrame as execState } from "../eval/generator-exec.js";
import { ANativeProcedure } from "../values/primitives/ANativeProcedure.js";
import { AExact } from "../values/primitives/AExact.js";
import { theVoid } from "../values/primitives/AVoid.js";
import type { SchemeValue } from "../values/types.js";

const env = (await freshEnv()) as EnvWithInternals<ResolvingAmbient>;
// COMPLEX tier (execState): stringifies the BOXED result (Scheme print format,
// e.g. list "(2 4 6)") — a boxed-state read, not the SIMPLE tier's plain-JS exit.
const run = async (form: string) => String((await execState(form, { env })).values[0]);

// An async ANativeProcedure returning a Promise — mirrors a membrane-crossing callback.
// W8: bare host fns are doored at `.bind`.
env.bind(
  "async-double",
  new ANativeProcedure({
    name: "async-double",
    arity: { min: 1, max: 1 },
    contract: undefined,
    impl: async (args) => new AExact(Number((args[0] as { valueOf(): number }).valueOf()) * 2),
  }),
);
env.bind(
  "async-noop",
  new ANativeProcedure({
    name: "async-noop",
    arity: { min: 0, max: null },
    contract: undefined,
    impl: async () => theVoid,
  }),
);

describe("vector/string map+for-each await async procs (no raw Promise leak)", () => {
  it("vector-map with an async proc yields settled values, not [object Promise]", async () => {
    // Assert via vector->list so the harness reprs the SETTLED elements (a raw
    // JS String() on the SchemeVector would print "[object Object]" regardless).
    const out = await run(`(vector->list (vector-map async-double (vector 1 2 3)))`);
    expect(out).not.toMatch(/\[object Promise\]/);
    expect(out).toBe("(2 4 6)");
  });

  it("string-map with an async proc yields settled chars, not [object Promise]", async () => {
    env.bind(
      "async-char",
      new ANativeProcedure({
        name: "async-char",
        arity: { min: 1, max: 1 },
        contract: undefined,
        impl: async (args) => args[0] as SchemeValue,
      }),
    );
    const out = await run(`(string-map async-char "abc")`);
    expect(out).not.toMatch(/\[object Promise\]/);
    expect(out).toBe("abc");
  });

  it("vector-for-each with an async proc completes (awaits) before returning", async () => {
    // for-each returns void; the point is it must AWAIT the async proc rather than
    // returning while promises are still outstanding. A tick counter is the witness —
    // `toBeDefined()` is true if the host returns immediately and drops the promises.
    let ticks = 0;
    env.bind(
      "async-tick",
      new ANativeProcedure({
        name: "async-tick",
        arity: { min: 0, max: null },
        contract: undefined,
        impl: async () => {
          ticks++;
          return theVoid;
        },
      }),
    );
    await run(`(vector-for-each async-tick (vector 1 2 3))`);
    expect(ticks).toBe(3);
  });
});
