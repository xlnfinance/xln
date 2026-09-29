/**
 * LAW (V1) — the environment-privatization design §II.1/D6:
 * `LexicalScope.fresh()`, the one new public API this round adds. Closes the "bare
 * `sandboxedEnv.child()` for isolation" gap — before this, minting an ISOLATED
 * scope required routing through the instance surface being retired (§II.1: "isolation
 * itself still routes through the surface being retired").
 *
 * Two rows:
 *   1. Two `LexicalScope.fresh()` calls are ISOLATED — a define in one is invisible to
 *      the other (each mints a null-rooted frame, never memoized against each other).
 *   2. ONE `LexicalScope.fresh()` shared across calls CONTINUES — REPL-style define
 *      accumulation works exactly like `execState(...).scope` round-tripping already does.
 */
import { describe, expect, it } from "vitest";
import { exec, execState } from "../../eval/generator-exec.js";
import { LexicalScope } from "../../eval/LexicalScope.js";

describe("LexicalScope.fresh() — isolation between two fresh scopes", () => {
  it("a define in one fresh scope is invisible to another fresh scope", async () => {
    const scopeA = LexicalScope.fresh("scope-a");
    const scopeB = LexicalScope.fresh("scope-b");

    await exec("(define secret 1)", { scope: scopeA });

    const [seenInA] = await exec("secret", { scope: scopeA });
    expect(seenInA).toBe(1);

    await expect(exec("secret", { scope: scopeB })).rejects.toThrow();
  });

  it("builtins still resolve for BOTH fresh scopes — isolation is lexical-only, the capability base is shared", async () => {
    const scopeA = LexicalScope.fresh();
    const scopeB = LexicalScope.fresh();
    const [a] = await exec("(+ 1 2)", { scope: scopeA });
    const [b] = await exec("(+ 3 4)", { scope: scopeB });
    expect(a).toBe(3);
    expect(b).toBe(7);
  });
});

describe("LexicalScope.fresh() — continuation across calls sharing ONE fresh scope", () => {
  it("REPL-style define accumulation works: a later call sees an earlier call's define", async () => {
    const scope = LexicalScope.fresh("repl-session");
    await exec("(define counter 0)", { scope });
    await exec("(define counter (+ counter 1))", { scope });
    const [result] = await exec("(+ counter 1)", { scope });
    expect(result).toBe(2);
  });

  it("execState's returned `scope` round-trips identically for a fresh() root (LexicalScope.for's per-env memoization)", async () => {
    const scope = LexicalScope.fresh("round-trip");
    const first = await execState("(define x 10)", { scope });
    // The SAME wrapper object comes back (memoized per env — LexicalScope.for),
    // exactly like the identity guarantee documented on ExecState.scope.
    expect(first.scope).toBe(scope);

    const second = await execState("(+ x 5)", { scope: first.scope });
    expect(second.values.at(-1)).toBeDefined();
    const [plain] = await exec("(+ x 5)", { scope });
    expect(plain).toBe(15);
  });
});
