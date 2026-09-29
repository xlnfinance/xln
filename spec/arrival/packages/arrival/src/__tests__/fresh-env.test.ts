import { describe, it, expect } from "vitest";
import { freshEnv } from "./_fresh-env.js";
import { execOverFrame as exec, execStateOverFrame as execState } from "../eval/generator-exec.js";
import { toJS } from "../membrane/rosetta.js";

/**
 * A fresh, per-call capability-assembled env must expose the WHOLE current
 * Scheme surface — native value-domain, BASE_PACKS, the cxr kernel unfold, and
 * builtins still bound inline on global_env.
 */
describe("freshEnv (capability-assembled test env)", () => {
  it("resolves native, BASE_PACK, cxr-kernel, AND still-inline builtins", async () => {
    const env = await freshEnv();
    // execState (COMPLEX tier): toJS wants the BOXED value — `exec` already unwraps.
    const run = async (src: string): Promise<unknown> => toJS((await execState(src, { env })).values[0], {});

    expect(await run("(+ 1 2)")).toBe(3);
    expect(await run("(list 1 2 3)")).toEqual([1, 2, 3]);
    expect(await run("(map (lambda (x) (* x x)) (list 2 3))")).toEqual([4, 9]);
    expect(await run('(string-length "abc")')).toBe(3);
    expect(await run("(car (cdr (list 10 20 30)))")).toBe(20);
    expect(await run("(dict :a 1 :b 2)")).toEqual({ a: 1, b: 2 });
    expect(await run("(find odd? (list 2 4 5))")).toBe(5);
  });

  it("isolates definitions per call (fresh layer each time)", async () => {
    const a = await freshEnv();
    await exec("(define probe 42)", { env: a });
    expect(toJS((await execState("probe", { env: a })).values[0], {})).toBe(42);

    const b = await freshEnv();
    await expect(exec("probe", { env: b })).rejects.toThrow();
  });
});
