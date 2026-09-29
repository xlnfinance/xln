// prelude-overlay.test.ts — end-to-end proof of the phase-gated `preludeOnly` mechanism
// (design doc §1.3) against the self-hosted vocabulary path (`buildVocabulary` +
// `env/assemble-run.ts`'s per-run prelude pass) — via `exec`/`execState({capabilities})`.
//
// STAGE C CUT 4 (docs/plans/stage-c-corpse-deletion.md) retired `lower()`/`assembleEnv`; this
// file's OWN mechanism (a bespoke `assembleEnv(base, [cap.lower({evalScheme})])` fixture) went
// with it. Re-authored against the sanctioned path: `exec`/`execState({capabilities})` builds
// the `Vocabulary` and runs the tuple's per-run prelude pass (`env/assemble-run.ts`'s
// `assembleRun`, step 3) as part of minting the RunContext, before any program form evaluates.
//
// RULING 2026-08-13 (audit B4, superseding the Stage-B2 discard finding this header used to
// record): a prelude `(define …)` PERSISTS into the main phase — it lands in the run's
// per-run prelude-define frame (assemble-run.ts), layered between the user's lexical scope
// and the vocabulary chain. What stays out is the preludeOnly SEED: "invocation survives,
// reference does not." Facts proven here, against the CURRENT model:
//   1. a preludeOnly verb is callable from a LATER capability's prelude during the per-run
//      prelude pass, and a plain unbound-variable error from user program code.
//   2. an ordinary prelude `(define …)` IS a main-phase binding for its run (per-run — never
//      shared across runs; the full law family is env/__tests__/prelude-persistence.law.test.ts).
//   3. the prelude scope ACCUMULATES across capabilities within ONE prelude pass (C3 dep order)
//      — proven via side-effecting rosetta calls (recording, not defining), which still observe
//      each other correctly within that one pass.
//   4. BOTH a lambda DEFINED BY a prelude (closing over a preludeOnly verb — V's blessed
//      require-extension shape) AND a value CAPTURED BY a prelude `(define …)` survive to
//      runtime, while the preludeOnly verb's NAME stays unresolvable from user code.

import { describe, expect, it } from "vitest";
import { exec, execState } from "../../eval/generator-exec.js";
import { EnvCapability } from "../capability.js";

describe("preludeOnly — the phase-gated per-run prelude pass (design §1.3, over the vocabulary path)", () => {
  it("a preludeOnly verb is UNBOUND at runtime, but a LATER capability's prelude that calls it during the prelude pass works", async () => {
    // Capability A contributes a preludeOnly rosetta. Capability B (deps on A) calls it from
    // its OWN prelude, recording the call as an observable side effect via a runtime-bound sink.
    const calls: string[] = [];
    const capA = EnvCapability.define("test/overlay-a", {
      symbols: (symbol, z) => ({
        "overlay/greet": symbol.rosetta`overlay/greet: prelude-only greeting verb`(
          { input: [z.string], output: [z.string], preludeOnly: true },
          (name) => `hello ${name}`,
        ),
      }),
    });
    const capB = EnvCapability.define("test/overlay-b", {
      deps: [capA],
      symbols: (symbol, z) => ({
        "sink/record": symbol.rosetta`sink/record: record a call for the test to observe`(
          { input: [z.string], output: [z.string] },
          (s) => {
            calls.push(s);
            return s;
          },
        ),
      }),
      // B's prelude calls A's preludeOnly verb (visible because A applied first — C3 dep
      // order — and the per-run prelude scope answers from BOTH the main map and the
      // preludeOnly overlay) and forwards the result to a RUNTIME-bound sink.
      prelude: `(sink/record (overlay/greet "world"))`,
    });

    // Minting a run for this tuple runs the prelude pass — before ANY program form evaluates.
    const state = await execState(`1`, { capabilities: [capB] });
    expect(calls).toEqual(["hello world"]);

    // The preludeOnly verb itself is a plain unbound-variable error from user code — nothing to
    // seal. Reuse the SAME runCtx (REPL continuity) so the prelude pass does not re-fire.
    await expect(exec(`(overlay/greet "again")`, { capabilities: [capB], runCtx: state.runCtx })).rejects.toThrow(
      /Unbound variable/,
    );
  });

  it("an ordinary prelude `define` lands in the run's prelude-define frame — resolvable from user code", async () => {
    const cap = EnvCapability.define("test/overlay-define", {
      prelude: `(define overlay-defined-value 42)`,
      symbols: () => ({}),
    });
    const state = await execState(`1`, { capabilities: [cap] });
    const results = await exec(`overlay-defined-value`, { capabilities: [cap], runCtx: state.runCtx });
    expect(results[0]).toBe(42);
  });

  // INVARIANT: the prelude scope accumulates across a chain of dependents in C3 order, WITHIN
  // one prelude pass — a shared Map for that pass, not rebuilt per capability.
  it("the prelude scope ACCUMULATES: A's preludeOnly verb is visible to a chain of TWO dependents via C3 order", async () => {
    const capA = EnvCapability.define("test/overlay-chain-a", {
      symbols: (symbol, z) => ({
        "chain/base-secret": symbol.rosetta`chain/base-secret: preludeOnly value contributed by A`(
          { input: [], output: [z.number], preludeOnly: true },
          () => 7,
        ),
      }),
    });
    // B deps on A, records what it saw at prelude-eval time.
    const bSeen: number[] = [];
    const capB = EnvCapability.define("test/overlay-chain-b", {
      deps: [capA],
      symbols: (symbol, z) => ({
        "chain/note": symbol.rosetta`chain/note: record a number seen during B's prelude`(
          { input: [z.number], output: [z.number] },
          (n) => {
            bSeen.push(n);
            return n;
          },
        ),
      }),
      prelude: `(chain/note (chain/base-secret))`,
    });
    // C deps on B (transitively on A) — proves the prelude scope is the SAME shared Map across
    // the whole prelude pass, not re-built per-capability.
    const cSeen: number[] = [];
    const capC = EnvCapability.define("test/overlay-chain-c", {
      deps: [capB],
      symbols: (symbol, z) => ({
        "chain/note-c": symbol.rosetta`chain/note-c: record a number seen during C's prelude`(
          { input: [z.number], output: [z.number] },
          (n) => {
            cSeen.push(n);
            return n;
          },
        ),
      }),
      prelude: `(chain/note-c (chain/base-secret))`,
    });

    await execState(`1`, { capabilities: [capC] });

    expect(bSeen).toEqual([7]);
    expect(cSeen).toEqual([7]);
  });

  it("THE CONTRACT: a prelude-defined closure AND a captured value both survive; the preludeOnly name does not", async () => {
    const cap = EnvCapability.define("test/overlay-closure", {
      symbols: (symbol, z) => ({
        "closure/secret": symbol.rosetta`closure/secret: preludeOnly source`(
          { input: [], output: [z.number], preludeOnly: true },
          () => 99,
        ),
      }),
      prelude: `
        (define (wrapper-bridge) (closure/secret))
        (define captured-secret (closure/secret))
      `,
    });
    const state = await execState(`1`, { capabilities: [cap] });

    const captured = await exec(`captured-secret`, { capabilities: [cap], runCtx: state.runCtx });
    expect(captured[0]).toBe(99);
    const viaWrapper = await exec(`(wrapper-bridge)`, { capabilities: [cap], runCtx: state.runCtx });
    expect(viaWrapper[0]).toBe(99);
    await expect(exec(`(closure/secret)`, { capabilities: [cap], runCtx: state.runCtx })).rejects.toThrow(
      /Unbound variable/,
    );
  });
});
