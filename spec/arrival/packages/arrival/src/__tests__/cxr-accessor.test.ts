/**
 * The `c[ad]+r` pair-accessor family — kernel-unfolded car/cdr COMPOSITION.
 *
 * car/cdr are no longer bound symbols and there is no "aside" resolver: the KERNEL synthesizes
 * the WHOLE family (`env_get` → `cxrUnfold`) by composing each receiver's OWN tagless-final
 * car/cdr algebra — car/cdr are the 1-step base case, `cadr`…`caddddr` the deeper compositions.
 * So any accessor word the sugarcoat lens fuses (`caddddr`, `caddadar`, …) evaluates, and the whole
 * family inherits the atoms' nil-tolerance (ANil reads the run's strict), provenance, and the
 * totalic "primitive does not support car" throw — no hand-maintained word list, no duplicated
 * field-access/typecheck.
 */
import { describe, expect, it } from "vitest";

import { execOverFrame as exec, execStateOverFrame as execState } from "../eval/generator-exec.js";
import { nativeOnlyRoot } from "./_fresh-env.js";
import { inferenceEnv } from "../env/inference-env.js";
import { toJS } from "../membrane/rosetta.js";
import { ANil } from "../values/primitives/ANil.js";
import type { ResolvingAmbient } from "../env/AmbientRuntime.js";

const evalIn =
  (env: ResolvingAmbient) =>
  async (expr: string): Promise<unknown> =>
    // execState (COMPLEX tier): toJS wants the BOXED value — `exec` already unwraps.
    toJS((await execState(expr, { env })).values[0], {});

// element index k ≡ (car (cdr^k x)) ≡ "ca" + "d"×k + "r"
const cxrForIndex = (k: number): string => `ca${"d".repeat(k)}r`;

const CXR_CASES = [
  // car/cdr — the 1-step base case — resolve via the kernel unfold
  { name: "car", expr: "(car '(10 20 30))", expected: 10 },
  { name: "cdr", expr: "(cdr '(10 20 30))", expected: [20, 30] },
  // standard composites still resolve (regression)
  { name: "cadr", expr: "(cadr '(10 20 30 40 50 60))", expected: 20 },
  { name: "caddr", expr: "(caddr '(10 20 30 40 50 60))", expected: 30 },
  { name: "cadddr", expr: "(cadddr '(10 20 30 40 50 60))", expected: 40 },
  // deep linear accessors resolve to the right element.
  // k=4: 5 inner letters; k=5: 6 — both past the old eager loop AND the SAFE_BUILTINS slice.
  { name: cxrForIndex(4), expr: `(${cxrForIndex(4)} '(10 20 30 40 50 60))`, expected: 50 },
  { name: cxrForIndex(5), expr: `(${cxrForIndex(5)} '(10 20 30 40 50 60))`, expected: 60 },
  // mixed combos compose car/cdr correctly
  { name: "cdar", expr: "(cdar '((1 2 3) 9))", expected: [2, 3] }, // drop-1 of the first element
  { name: "caadr", expr: "(caadr '(10 (100 200) 30))", expected: 100 }, // first of the second element
  // third of the first element: car→(1 2 3 4), cdr, cdr, car→3
  { name: "caddar", expr: "(caddar '((1 2 3 4) 9))", expected: 3 },
] as const;

// Run the SAME expressions through both roots. The kernel unfold is env-independent (no per-env
// binding, no resolver), so a bare native-only root and inferenceEnv resolve the family
// identically. The list INPUTS use quote literals (`'(…)`, reader-level) rather than `(list …)`
// so the data needs no env binding either — `list` is a pack builtin (env/r7rs/lists.ts), bound
// on the assembled inference root but NOT on the bare native-only root; quote keeps this test
// isolated to the cxr unfold it targets.
const roots: readonly [string, ResolvingAmbient][] = [
  ["nativeOnlyRoot", await nativeOnlyRoot()],
  ["inferenceEnv", inferenceEnv],
];
for (const [label, env] of roots) {
  describe(`c[ad]+r evaluation in ${label}`, () => {
    const run = evalIn(env);

    it.each(CXR_CASES)("cxr · $name", async ({ expr, expected }) => {
      expect(await run(expr)).toEqual(expected);
    });

    it("an accessor that walks off the end follows the run's nil-projection — tolerant ⇒ nil, strict ⇒ throw", async () => {
      // (cadr (list 1)): cdr → (), then car of () — the unified ANil nil-projection. The WHOLE
      // family now inherits the atoms' mode-gating (the old strict resolver always threw here).
      // execState (COMPLEX tier): asserts box discipline (`toBeInstanceOf(ANil)`, RULINGS.md R1).
      expect((await execState("(cadr '(1))", { env })).values[0]).toBeInstanceOf(ANil);
      await expect(exec("(cadr '(1))", { env, strict: true })).rejects.toThrow();
    });
  });
}
