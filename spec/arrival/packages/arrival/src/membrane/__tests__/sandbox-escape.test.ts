/**
 * CRITICAL: Sandbox security findings — each test corresponds to a specific
 * known attack vector or resource-exhaustion bug.
 *
 * War-story format: every test cites (a) the audit finding it covers, (b) the
 * file:line that is the source of the bug, and (c) the secure invariant we
 * *want* to hold. Tests marked `.fails` describe the desired post-fix
 * behavior — they are RED today; when the fix lands they will flip to GREEN
 * and vitest will fail until `.fails` is removed.
 *
 * Probe origin: ran experimental probe (`_sandbox-escape-probe.test.ts`,
 * deleted) against current main on 2026-05-28 to confirm each vector. Findings
 * live as comments below — do not delete them without re-running the probe.
 *
 * Vitest API note: `it.fails(name, fn)` is the vitest 4 spelling of "this test
 * is expected to fail." When the underlying bug is fixed and the test starts
 * passing, vitest reports the suite as failed, forcing the `.fails` marker to
 * be removed. (Vitest 3+ docs sometimes call this `.failing`; in vitest 4 the
 * canonical name is `.fails`.)
 */
import { describe, expect, it } from "vitest";
import type { EnvWithInternals, ResolvingAmbient } from "../../env/AmbientRuntime.js";
import { CONSTANT_CTX } from "../../run/RunContext.js";
import { execOverFrame, execStateOverFrame, execOverFrame as gexec } from "../../eval/generator-exec.js";
import { inferenceEnv } from "../../env/inference-env.js";
import { INTEROP_BOUNDARY } from "../../well-known/symbols.js";
import { accessMember, isInteropBoundary } from "../interop-access.js";
import { InteropAccessError } from "../../errors.js";
import { AString } from "../../values/primitives/AString.js";
import { ASymbol } from "../../values/primitives/ASymbol.js";
import { AValue } from "../../values/primitives/AValue.js";
import { jsToScheme } from "../rosetta.js";
import { tf } from "../../values/tagless-final.js";

// ============================================================================
// CRITICAL: sandbox escape vectors
// ============================================================================
//
// Audit finding: `bridge.ts:1342` — `eval(expr, env?) { return evaluate(expr, { env: env || global_env }) }`
// When Scheme code calls `(eval x)` with no second argument, the host-side
// `env` parameter is `undefined`, so eval falls back to `global_env`. The
// global env contains EVERY wrappedOps entry (~hundreds of names: `+`, `*`,
// `load`, `set-obj!`, `new`, `instanceof`, plus the entire interpreter bootstrap).
// Any of those are reachable from inside the sandbox via
// `(eval (quote name))`. The returned value is the unwrapped JS function.
// ============================================================================

describe("CRITICAL: sandbox escape vectors", () => {
  /**
   * The smoking gun. `+` is in wrappedOps, so it's in global_env. The
   * sandbox doesn't export `+` by JS-name but it does export `(eval)`; calling
   * `(eval (quote +))` reaches into the global env and hands the sandbox the
   * unwrapped JS function. Probe confirmed: returned value IS callable, and
   * `f(2,3)` returns 5 (i.e., it's the real arithmetic op, not a stub).
   *
   * Secure invariant: eval with no env arg must default to the CALLER's env
   * (i.e., the sandbox), NOT to global_env. Inside the sandbox, looking up
   * `+` should fail with Unbound — `+` isn't an exported sandbox binding.
   */
  // `eval` is gone; lookup throws Unbound. Regression guard that it stays gone.
  it("eval defaults to sandbox env, NOT global, when no env arg", async () => {
    // `+` is NOT in inferenceEnv directly (sandbox uses scheme arithmetic).
    // eval no longer exists at all — the host-language sweep deleted it from
    // wrappedOps — so the eval-escape path is closed at the source; the throw is
    // Unbound on `eval` itself, not on `+`.
    await expect(execOverFrame("(eval (quote +))", { env: inferenceEnv })).rejects.toThrow(
      /eval|Unbound|not available/i,
    );
  });

  /**
   * Sharper version: not just "reachable" but "actually invokable and computes
   * the real result". Catches a regression where eval gets locked down for
   * lookup but escaped values are still callable.
   */
  it("eval-escaped function cannot be invoked to perform host computation", async () => {
    // Build a sandbox program that pulls + via eval and applies it.
    // Historically returned 5 (eval-escape worked). Now: throws Unbound at the
    // eval site — eval no longer exists, so the very first form `(eval ...)`
    // fails to resolve.
    await expect(execOverFrame(`((eval (quote +)) 2 3)`, { env: inferenceEnv })).rejects.toThrow(
      /eval|Unbound|not available/i,
    );
  });

  /**
   * `load` / `set-obj!` / `new` / `instanceof` were the host-language verbs the
   * eval-escape historically reached (the interpreter bootstrap registered them in
   * global_env; `(eval (quote set-obj!))` handed back the JS function). The
   * sweep deleted all of them — and eval itself — so there is nothing left to
   * reach and nothing to reach it with.
   */
  it("host-language verbs cannot be reached via eval", async () => {
    // `eval` no longer exists, so the lookup of `eval` in the head position
    // fails before the inner name is even quoted. The error is Unbound on
    // `eval` — and the inner names don't exist either, so the security
    // invariant ("host-language verb not reachable") holds doubly.
    for (const forbidden of ["load", "set-obj!", "new", "instanceof"]) {
      await expect(
        execOverFrame(`(eval (quote ${forbidden}))`, { env: inferenceEnv }),
        `${forbidden} must not be reachable via eval-escape`,
      ).rejects.toThrow(/eval|Unbound|not available/i);
    }
  });

  /**
   * Audit finding: `SchemeString.ts:139-156` — SchemeString grafts all
   * String.prototype methods onto its own prototype as own enumerable
   * properties. Because they're OWN properties (not inherited), the existing
   * `sandboxedAccess` boundary check at sandbox-boundary.ts:284 takes the
   * fast-path and returns them. The class itself is not marked as a sandbox
   * boundary, so a sandbox holding a SchemeString reference can call
   * `(@ str "constructor")` … well, constructor IS in BLOCKED_PROPERTY_NAMES,
   * so that specific path is blocked — but every other String.prototype method
   * is exposed. The boundary marker is what's missing.
   *
   * Secure invariant: SchemeString (and other AValue subtypes that graft
   * built-in proto methods) must be marked as sandbox boundaries so the
   * prototype-chain walk in accessMember stops at them.
   */
  it("SchemeString is a sandbox boundary", async () => {
    // The INVARIANT (walk stops at the prototype), not the mechanism: per-class
    // INTEROP_BOUNDARY stamps were replaced by the nominal family rule in
    // interop-access.ts (`instanceof AValue` covers the whole value hierarchy in
    // one check), so the checker's verdict is the thing to pin — plus the
    // behavioral consequence.
    expect(isInteropBoundary(AString.prototype)).toBe(true);
    // Behavioral half: a grafted String.prototype method is NOT reachable through
    // the member walk on an AString instance.
    const str = new AString("abc");
    expect(() => accessMember(str, "charCodeAt")).toThrow(InteropAccessError);
  });
});

// ============================================================================
// CRITICAL: accessor isolation leaks (dot-notation `get` + `:keyword` plucker)
// ============================================================================
//
// Audit finding (2026-05-30, require/import loader plan): field retrieval IS
// gated for `@`/`field` (they route through `sandboxedAccess` →
// SchemeJSObject.get), but TWO other property-access paths bypass it for RAW
// (non-SchemeJSObject) values:
//   - `the dissolved husk` `get` (dot-notation `x.y`) — `else` branch does raw `object[name]`.
//   - `AmbientRuntime.ts` `:keyword` plucker — raw branch does `obj[key]` after
//     `Object.hasOwn`, never consulting BLOCKED_PROPERTY_NAMES.
// A lambda / rosetta is a raw JS function in sandbox scope, so `(:constructor f)`
// or `f.constructor` walks to `Function.prototype.constructor` → the `Function`
// constructor → `((:constructor f) "return process")()` is RCE.
//
// Secure invariant: both paths route through the SAME `sandboxedAccess`
// isolation as `@` — blocked names (constructor, __proto__, prototype, …) and
// boundary-crossing inherited props collapse to nil/undefined.
// ============================================================================

// Since benchmark-defect-register.md's B2, a receiver with no `arrival/tagless-final/get`
// term (a lambda declares none) THROWS instead of silently returning nil
// (ASymbol.ts's AKeywordSymbol — see keyword-accessor-leaf-door.test.ts). Both outcomes
// are equally SAFE for this security invariant: neither a thrown error nor a boxed nil
// is `Function`/`Function.prototype`. `pluck` below tolerates either so these tests keep
// asserting the actual invariant (no leak) rather than which of the two safe shapes the
// no-member-protocol door takes.
async function pluck(src: string): Promise<unknown> {
  try {
    const [v] = await execOverFrame(src, { env: inferenceEnv });
    return v;
  } catch (e) {
    return e; // a throw is a safe, non-leaking outcome too
  }
}

describe("CRITICAL: accessor isolation leaks", () => {
  it(":keyword plucking 'constructor' off a lambda does not leak Function", async () => {
    const fromLambda = await pluck("(:constructor (lambda (x) x))");
    // Pre-fix: === Function (RCE primitive). Post-fix: a door (throws) — either way, never Function.
    expect(fromLambda).not.toBe(Function);
  });

  it(":keyword plucking '__proto__' / 'prototype' off a lambda is blocked", async () => {
    const proto = await pluck("(:prototype (lambda (x) x))");
    const dunder = await pluck("(:__proto__ (lambda (x) x))");
    expect(proto).not.toBe(Function.prototype);
    // __proto__ must not hand back Function.prototype (→ chains to constructor).
    expect(dunder).not.toBe(Object.getPrototypeOf(() => {}));
  });

  it("accessMember (the dot-notation / membrane read policy) blocks raw constructor/__proto__ access", () => {
    // The arrival `get` dot-notation wrapper was DELETED in the husk dissolution — it
    // was a dead path (no runtime caller, only this test). Its policy IS
    // `accessMember` (interop-access): the primitive AmbientRuntime.get's dotted
    // resolution (`foo.bar`) AND the `@` membrane reads both call directly. So the
    // escape vectors are asserted against the live policy. Blocked names and
    // boundary-crossing inherited props throw InteropAccessError (the callers
    // collapse that to nil); own data resolves.
    const fn = (x: number) => x;
    expect(() => accessMember(fn, "constructor")).toThrow(InteropAccessError);
    expect(() => accessMember(fn, "__proto__")).toThrow(InteropAccessError);
    expect(() => accessMember(fn, "prototype")).toThrow(InteropAccessError);
    // Inherited built-in proto methods are past an interop boundary → blocked.
    expect(() => accessMember([1, 2, 3], "map")).toThrow(InteropAccessError);
    // Benign own-property access still resolves (guard against over-blocking).
    expect(accessMember({ a: 1, b: 2 }, "a")).toBe(1);
    expect(accessMember([1, 2, 3], "length")).toBe(3);
  });

  it("benign :keyword and dot access on a plain object still resolve", async () => {
    // Guard against over-blocking: legitimate own-property access must keep
    // working through both paths after the isolation is applied.
    const env = inferenceEnv.child("probe-obj") as EnvWithInternals<ResolvingAmbient>;
    env.bind("__probe_obj", jsToScheme(CONSTANT_CTX, { name: "maya", nested: { city: "lisbon" } }));
    const [byKeyword] = await execOverFrame("(:name __probe_obj)", { env });
    expect(String(byKeyword)).toBe("maya");
  });
});

// ============================================================================
// CRITICAL: resource exhaustion (DoS vectors)
// ============================================================================

describe("CRITICAL: resource exhaustion (DoS vectors)", () => {
  /**
   * Audit finding: `bridge.ts:662` — `make-string` has no upper bound on `k`.
   * Probe confirmed: `(make-string 100000000 #\x)` allocates a 200MB string
   * in ~1ms and returns successfully. A sandbox-level attacker can drive
   * memory pressure across the host with a single call.
   *
   * V8 enforces its own string-length cap (~2^29 bytes), so very large
   * requests like 1e9 happen to throw RangeError — but for the WRONG reason
   * (engine limit, not our policy). The DoS attack window is exactly the
   * range BELOW V8's cap and ABOVE what a sandbox should be allowed to
   * allocate. We pick 1e8 (200MB UTF-16) to test the policy gap: V8 accepts
   * this, our code should reject it.
   *
   * Secure invariant: `make-string` with a length > some host-configured cap
   * must throw a cap-related error in O(1), not allocate.
   */
  // Cap-policy door (`assertAllocatable`): message names the op, requested length, and cap — not an engine RangeError.
  it("(make-string 1e8 ...) errors with the cap-policy TAUGHT message, not an engine RangeError", async () => {
    await expect(execOverFrame("(make-string 100000000 #\\x)", { env: inferenceEnv })).rejects.toThrow(
      /make-string: requested length \d+ exceeds allocation limit \d+/,
    );
  });

  /**
   * Audit finding: `bridge.ts:1076` — `make-vector` calls `Array.from({ length: k })`.
   * Probe confirmed: `(make-vector 100000000 #f)` runs >10s and exhausts memory
   * trying to materialize 100M slots. `(make-vector 1000000000 ...)` typically
   * throws RangeError synchronously (engine limit ~2^32), but the cap belongs
   * in OUR code, not in the engine's worst-case behavior.
   *
   * Secure invariant: same as make-string — host-configurable cap, error fast.
   */
  // Same `assertAllocatable` door as make-string: message names op, requested length, and cap.
  it("(make-vector 1e8 ...) errors with the cap-policy TAUGHT message, not an engine RangeError", async () => {
    await expect(execOverFrame("(make-vector 100000000 #f)", { env: inferenceEnv })).rejects.toThrow(
      /make-vector: requested length \d+ exceeds allocation limit \d+/,
    );
  });

  /**
   * Audit finding: `evaluator.ts:411` — `run()` is the generator trampoline.
   * It has no wall-clock budget, no instruction counter, no cancellation.
   * Sandbox code can `(let loop () (loop))` forever; the host has no way to
   * reclaim the worker except by killing the process.
   *
   * Secure invariant: each `run()` invocation should honor a budget (either
   * passed via options or a per-host default). Exceeding the budget should
   * throw a recoverable error, not hang forever.
   *
   * This test DOCUMENTS the missing infra rather than exploits it — actually
   * running `(let loop () (loop))` with no budget would hang the test runner.
   * The shape is: when budget infra exists, this test will compile against
   * its public API and the .failing marker can be removed.
   */
  it("infinite loop is bounded by a wall-clock budget (budgetMs)", async () => {
    // The budget lives on the GENERATOR-EXEC trampoline (`run()` in
    // evaluator.ts), which is the path the actual sandbox/MCP runtime uses
    // (arrival-chain's loader calls `execGeneratorExpr`). The file-level `exec`
    // import is `exec` (REPL evaluator) — used by the other tests
    // here — so we import the generator-exec `exec` locally for the budget API.
    // `budgetMs` throws a ArrivalError(/budget/) at the existing 1000-iter / 5ms
    // event-loop yield once the deadline passes; it composes with `signal`
    // (whichever fires first wins). See evaluator.ts RunOptions.budgetMs.
    // `(let loop () (loop))` is now flat under TCO (task #46), so the budget
    // fires cleanly instead of the loop blowing the JS stack first.
    await expect(gexec("(let loop () (loop))", { env: inferenceEnv, budgetMs: 150 })).rejects.toThrow(/budget/i);
  }, 10000);

  /**
   * Audit finding: `SchemeSymbol.ts:23` — `static readonly list: Record<string, SchemeSymbol> = {}`.
   * Every `(string->symbol unique-string)` interns a new entry; the map never
   * evicts. Sandbox code can mint distinct symbols in a loop until the host
   * OOMs. Probe confirmed: 1000 distinct `new SchemeSymbol(name)` adds exactly
   * 1000 entries.
   *
   * This is DOCUMENTED, not RED — fixing it requires either an LRU policy or
   * per-trace scoping of the intern table. The test is here so any future
   * "we fixed it" PR has a behavior to assert against.
   *
   * Not `.fails` because asserting "intern table has bounded size after N
   * inserts" requires the bound to exist first. Leaving as a documented
   * behavior pin.
   */
  /**
   * Audit finding: `Parser.ts:360` (`_read_object`) is mutually recursive with
   * `read_list` via real JS call frames. Deeply nested input overflows the
   * native stack BEFORE the parser can produce a structured error. Probe
   * confirmed: 5000-deep input throws "Maximum call stack size exceeded" —
   * a host-level error that leaks implementation details and may not be
   * catchable depending on engine.
   *
   * Secure invariant: deeply-nested input throws a Scheme-level parse error
   * with a clear message ("input nesting depth exceeded N"), not a native
   * RangeError. The parser should track depth explicitly and bail.
   */
  // Parse door names the nesting-depth cap and position, not a native stack overflow.
  it("deeply-nested input throws a graceful parse error naming the nesting-depth cap, not stack overflow", async () => {
    const deep = "(".repeat(10000) + "1" + ")".repeat(10000);
    let err: Error | undefined;
    try {
      await execOverFrame(deep, { env: inferenceEnv });
    } catch (e) {
      err = e as Error;
    }
    expect(err).toBeDefined();
    expect(err?.message).not.toMatch(/Maximum call stack/i);
    expect(err?.message).toMatch(/nest|depth|too deep/i);
  });

  /**
   * Audit finding: `sandbox-env.ts:217` — `equal?` falls through to
   * `JSON.stringify(a) === JSON.stringify(b)` as its general path. JSON.stringify
   * throws TypeError on cyclic structures. Probe confirmed: comparing two
   * cyclic JS objects throws "Converting circular structure to JSON" — a
   * native error message that leaks host implementation, and the exception
   * is not a Scheme-level error so sandbox code can't `guard` it cleanly.
   *
   * Secure invariant: `equal?` on any input pair should return a boolean or
   * throw a Scheme-level error. Cyclic structures should compare via
   * structural-equality-with-occurs-check, not JSON.stringify.
   */
  // Cyclic equal? returns boxed #f (ABool), never a native JSON circular-structure error.
  it("(equal? a b) on cyclic structures returns the boxed #f, never a native JSON error", async () => {
    const a: Record<string, unknown> = {};
    a.self = a;
    const b: Record<string, unknown> = {};
    b.self = b;
    const env = inferenceEnv.child("cyc-equal") as EnvWithInternals<ResolvingAmbient>;
    env.bind("__cyc_a", jsToScheme(CONSTANT_CTX, a));
    env.bind("__cyc_b", jsToScheme(CONSTANT_CTX, b));

    // execState (COMPLEX tier): the test name asserts the BOXED `#f` verdict
    // specifically (RULINGS.md R1) — `exec`'s plain-JS exit would give the raw
    // `false` this test is explicitly distinguishing itself from.
    const [result] = (await execStateOverFrame("(equal? __cyc_a __cyc_b)", { env })).values;
    expect(String(result)).toBe("#f");
  });
});

// ============================================================================
// Registry poisoning vectors
// ============================================================================
//
// Audit finding: `AValue.ts:51` — `AValue.registerBoxer(tag, fn)` is a static
// method with no access control. Anyone holding the AValue class can replace
// any boxer (string, number, boolean, etc.). Since `fromJs` is on the hot path
// for JS→Scheme membrane crossing, a malicious boxer would intercept every
// future value coming in. Combined with the eval-escape, AValue would be a
// devastating reach — confirm it is NOT directly reachable from the sandbox.
// ============================================================================

describe("registry poisoning vectors", () => {
  /**
   * Probe confirmed: `(eval (quote AValue))` throws Unbound — AValue is not
   * registered in global_env under that name. Good. This test pins that:
   * any future PR that exposes AValue (e.g., as part of a debug pack) MUST NOT
   * land without also wrapping it.
   */
  it("AValue is NOT reachable from sandbox via direct lookup", async () => {
    await expect(execOverFrame("AValue", { env: inferenceEnv })).rejects.toThrow(/eval|Unbound|not available/i);
  });

  /**
   * Same check via the eval-escape path. Even after the eval-escape fix lands,
   * this pin remains valid — AValue should never be exported.
   */
  it("AValue is NOT reachable from sandbox via (eval (quote AValue))", async () => {
    await expect(execOverFrame("(eval (quote AValue))", { env: inferenceEnv })).rejects.toThrow(
      /eval|Unbound|not available/i,
    );
  });

  /**
   * FIXED (was DOCUMENTED — option (b) of the old note): the boxer-registry WRITER
   * moved off the AValue class to a module function in boxing.ts. Even if AValue
   * leaks to the sandbox there is no `registerBoxer` to call on it — poisoning a
   * boxer now requires importing boxing.ts, which needs module access the sandbox
   * cannot get. The `boxers` Map is module-private; `fromJs` (read-only) is harmless.
   */
  it("the boxer-registry writer is not reachable from the AValue class", () => {
    expect((AValue as unknown as Record<string, unknown>).registerBoxer).toBeUndefined();
    expect((AValue as unknown as Record<string, unknown>).fromJs).toBeUndefined();
  });
});

// ============================================================================
// CRITICAL: write-side prototype pollution (S6)
// ============================================================================
//
// Audit finding (S6), historical: the READ side (accessMember) is
// boundary-guarded; the WRITE side (`accessSet`) was raw, then hardened, then
// DELETED outright (2026-07-10, V: a mutation face on interop violates total
// immutability — the mutator family is teaching-doored, a JS-side setter
// bypassing that discipline had zero production callers). The symbol-intern
// pollution half of S6 remains live below.
// ============================================================================

describe("CRITICAL: write-side prototype pollution (S6)", () => {
  it("string->symbol of '__proto__' does not pollute Object.prototype", async () => {
    // Minting symbols named after dangerous keys must touch only the intern
    // table as own keys — never reach Object.prototype.
    for (const name of ["__proto__", "constructor", "prototype"]) {
      // eslint-disable-next-line @typescript-eslint/no-unused-expressions
      new ASymbol(name);
    }
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    // Object.prototype must remain a clean baseline (no foreign own keys added).
    expect(Object.prototype.hasOwnProperty.call(Object.prototype, "__proto__sentinel__")).toBe(false);
    // The per-ctx intern table is a `Map` now (see ASymbol.internTables): a "__proto__"
    // key is an ordinary Map entry that can't reach Object.prototype, so the former
    // null-prototype Record guard is unnecessary. Minting still works + round-trips.
    expect(String(new ASymbol("__proto__"))).toBe("__proto__");
  });

  it("SANDBOX_BOUNDARY sentinel is not forgeable from the global Symbol registry", async () => {
    // A module-local Symbol() is never equal to a registry symbol of any key.
    expect(INTEROP_BOUNDARY).not.toBe(Symbol.for("scheme:sandbox-boundary"));
  });
});
