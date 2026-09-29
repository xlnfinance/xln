/**
 * LAW — prelude `(define …)` PERSISTS into the main execution phase; preludeOnly
 * NAMES do not (V's ruling, 2026-08-13, hermeticity audit B4).
 *
 * The refined preludeOnly contract: symbol INVOCATION survives, symbol REFERENCE
 * does not. A prelude must be able to write
 *
 *     (define (something) (prelude-symbol prelude-arg))
 *
 * and `(something)` works in the main phase — the define lands in a PER-RUN
 * define frame layered between the user's lexical scope and the vocabulary
 * chain, and its body still reaches `prelude-symbol` through ordinary lexical
 * capture. Yet neither `prelude-symbol` nor any other preludeOnly binding is
 * directly resolvable from main-phase code — the seed frame holding them is
 * never part of the main chain. This is crucial for require extensions: a
 * pack's prelude is its only channel for contributing scheme-defined wrappers.
 *
 * Resolution order (main phase): user lexical scope → per-run prelude defines →
 * vocabulary chain. Collision rules pinned below fall out of that order plus
 * the prelude-phase seed order (main map bound first, preludeOnly second —
 * preludeOnly SHADOWS a same-named main symbol during the prelude pass only).
 *
 * Supersedes the "prelude `(define …)` is DISCARDED, uniformly" paragraph of
 * docs/environments.md §7a (ruling recorded there).
 */
import { describe, expect, it } from "vitest";

import { EnvCapability } from "../../common/capability.js";
import { exec, execState } from "../../eval/generator-exec.js";
import { UnboundVariableError } from "../../errors.js";
import { toJS } from "../../membrane/rosetta.js";

const boxed = (v: unknown): unknown => toJS(v as never);

describe("prelude-define persistence (audit B4)", () => {
  /** V's exact scenario: a prelude-defined wrapper over a preludeOnly verb. */
  const wrapperCap = EnvCapability.define("test/prelude-persist-wrapper", {
    prelude: `(define (something) (prelude-symbol "arg"))`,
    symbols: (symbol, sz) => ({
      "prelude-symbol": symbol.rosetta`prelude-symbol: assembly-time-only`(
        { input: [sz.string], output: [sz.string], preludeOnly: true },
        (s) => `secret:${s}`,
      ),
    }),
  });

  it("P-PRELUDE-DEFINE-INVOKE — a prelude-defined wrapper is callable in the main phase; its body reaches the preludeOnly verb by capture", async () => {
    const results = await exec("(something)", { capabilities: [wrapperCap] });
    expect(results[0]).toBe("secret:arg");
  });

  it("N-PRELUDE-ONLY-REF — the preludeOnly verb itself stays unresolvable from the main phase", async () => {
    await expect(exec(`(prelude-symbol "x")`, { capabilities: [wrapperCap] })).rejects.toBeInstanceOf(
      UnboundVariableError,
    );
    await expect(exec("prelude-symbol", { capabilities: [wrapperCap] })).rejects.toBeInstanceOf(UnboundVariableError);
  });

  it("P-PRELUDE-DEFINE-PERSISTS — a plain prelude define is a main-phase binding (supersedes the discard law)", async () => {
    const cap = EnvCapability.define("test/prelude-persist-plain", {
      prelude: "(define leaked 42)",
      symbols: () => ({}),
    });
    const results = await exec("leaked", { capabilities: [cap] });
    expect(results[0]).toBe(42);
  });

  it("P-PRELUDE-DEFINE-REPL — runCtx reuse keeps the same per-run defines without re-preluding", async () => {
    const cap = EnvCapability.define("test/prelude-persist-repl", {
      prelude: "(define repl-kept 7)",
      symbols: () => ({}),
    });
    const state = await execState("repl-kept", { capabilities: [cap] });
    expect(boxed(state.values[0])).toBe(7);
    const again = await exec("repl-kept", { capabilities: [cap], runCtx: state.runCtx });
    expect(again[0]).toBe(7);
  });

  it("P-PRELUDE-DEFINE-SHADOWS — a prelude define sits ABOVE the vocabulary in the main chain; a user define sits above both", async () => {
    const cap = EnvCapability.define("test/prelude-persist-shadow", {
      prelude: `(define shadowed "prelude")`,
      symbols: (symbol, sz) => ({
        shadowed: symbol.rosetta`shadowed: vocabulary-bound`({ input: [], output: [sz.string] }, () => "vocabulary"),
      }),
    });
    // prelude define wins over the vocabulary binding…
    const results = await exec("shadowed", { capabilities: [cap] });
    expect(results[0]).toBe("prelude");
    // …and a user top-level define wins over the prelude define.
    const user = await exec(`(define shadowed "user") shadowed`, { capabilities: [cap] });
    expect(user.at(-1)).toBe("user");
  });

  it("P-PRELUDE-PHASE-SHADOW — on a cross-capability name collision, preludeOnly shadows main DURING the prelude pass only", async () => {
    // cap A: preludeOnly `which-x`; cap B: main-phase `which-x`. The prelude pass seeds
    // main map first, preludeOnly second — so a prelude closure sees the preludeOnly one,
    // while main-phase code sees only cap B's.
    const capA = EnvCapability.define("test/prelude-collide-a", {
      prelude: `(define (from-prelude) (which-x))`,
      symbols: (symbol, sz) => ({
        "which-x": symbol.rosetta`which-x: assembly-time twin`(
          { input: [], output: [sz.string], preludeOnly: true },
          () => "assembly",
        ),
      }),
    });
    const capB = EnvCapability.define("test/prelude-collide-b", {
      symbols: (symbol, sz) => ({
        "which-x": symbol.rosetta`which-x: runtime twin`({ input: [], output: [sz.string] }, () => "runtime"),
      }),
    });
    const results = await exec("(list (from-prelude) (which-x))", {
      capabilities: [capA, capB],
    });
    expect(results[0]).toEqual(["assembly", "runtime"]);
  });

  it("P-PRELUDE-DEFINE-ISOLATION — two runs of the same tuple never share defines", async () => {
    let stamp = 0;
    const cap = EnvCapability.define("test/prelude-persist-isolation", {
      prelude: "(define run-stamp (mint-stamp))",
      symbols: (symbol, sz) => ({
        "mint-stamp": symbol.rosetta`mint-stamp: per-run stamp`(
          { input: [], output: [sz.number], preludeOnly: true },
          () => ++stamp,
        ),
      }),
    });
    const first = await exec("run-stamp", { capabilities: [cap] });
    const second = await exec("run-stamp", { capabilities: [cap] });
    expect(first[0]).toBe(1);
    expect(second[0]).toBe(2);
  });
});
