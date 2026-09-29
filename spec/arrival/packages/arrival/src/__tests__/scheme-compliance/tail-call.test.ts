/**
 * Tail-Call Optimization coverage (R7RS §3.5).
 *
 * The TCO landed in commit 399e2c4bb. Its one shipped test (evaluator.spec.ts
 * "tail recursion to 10k depth") exercised exactly ONE tail position —
 * self-recursion through `if`'s else arm. This file covers every position the
 * implementation marks tail (evaluator.ts), plus negative tests proving the
 * NON-tail positions were NOT over-optimized.
 *
 * ── How the proof works (architecture-specific) ──────────────────────────────
 * The evaluator runs on a FLAT trampoline: `run()` keeps an explicit heap
 * `stack[]` of generators, and every `evaluate` is `yield { call }`-pushed onto
 * it — NOT onto the host JS call stack. This shapes what "missing TCO" and
 * "over-optimization" actually look like, and it is NOT what the naive framing
 * (catchable "Maximum call stack size exceeded") assumes. Verified empirically
 * while authoring this file:
 *
 *   • POSITIVE proof of O(1): completing at 50k. Before this TCO each
 *     Scheme→Scheme lambda call spawned a nested `run()` whose Promise the
 *     outer trampoline awaited, growing the HOST stack ~one frame per level and
 *     throwing a catchable RangeError at ~10k (see evaluator.spec.ts's 10k
 *     test + abort.test.ts's war story). 50k is 5× past that ceiling, so any
 *     tail position that still spawned a nested `run()` would RangeError before
 *     50k. Reaching the answer at 50k therefore proves the position is flat.
 *     ⇒ If a positive here throws/overflows, the TCO MISSED that tail position.
 *        Report it; do NOT `.fails`-mask it.
 *
 *   • NEGATIVE proof (no over-optimization) is SEMANTIC, not resource-based.
 *     A non-tail recursion (e.g. `(+ (sum (- n 1)) 1)`, an *argument*) does NOT
 *     throw a catchable error when deep: its frames pile onto the heap `stack[]`
 *     (not the host stack), so it grows memory until a FATAL, un-catchable
 *     `Reached heap limit` OOM. Confirmed: `(sum 1000000)` returns 1000000
 *     without throwing; under `--max-old-space-size=512` it hard-crashes the
 *     worker. So a non-tail negative CANNOT be `expect(...).rejects.toThrow()`
 *     — that assertion is both false (no catchable throw) and dangerous (the
 *     OOM taints the whole worker). Instead we detect over-optimization
 *     SEMANTICALLY: a wrongly-collapsed tail call drops the pending
 *     `(+ … 1)` / trailing-`begin` frames, so the accumulated result comes out
 *     WRONG. We assert the exact accumulated value. (Heap-residue measurement
 *     was also tried and rejected: without `--expose-gc` the `heapUsed` delta is
 *     GC-timing noise — a 50k non-tail run measured ~110MB while a 50k tail run
 *     measured ~130MB, i.e., the signal inverted. Any fixed MB floor/ceiling is
 *     therefore flaky here.)
 *
 *   • cond's `=>` arm USED to be a deliberately-non-tail position — it applied
 *     the proc via a nested `run()`, so a deep `=>` loop grew the HOST stack and
 *     overflowed (the "outside the TCO surface" war story). That is FIXED: the
 *     `=>` application now routes through `applyArrowProc`, which speaks the same
 *     bounce protocol as a normal `evaluatePair` application, so a self-recursive
 *     `=>` loop collapses on the trampoline exactly like the other tail arms. The
 *     positive below ("cond => arm — the (proc test) application is tail") proves
 *     it at 50k. `case`'s `=>` arm rides the same helper. (Historical note: the
 *     OLD nested-`run()` path also destabilized the vitest worker — a flaky
 *     UNHANDLED rejection / hang. The bounce path eliminates the nested `run()`
 *     entirely, so the case is now stable as a sibling.)
 *
 * `run()` helper: same path as evaluator.spec.ts's tail-recursion test
 * (generator-exec `exec`, full default env for `if`/`=`/`-`/`+`), returning the
 * unwrapped value of the last top-level form.
 */
import { describe, expect, it } from "vitest";
import type { EnvWithInternals, ResolvingAmbient } from "../../env/AmbientRuntime.js";
import { execState, execStateOverFrame } from "../../eval/generator-exec.js";
import { freshEnv } from "../_fresh-env.js";
import { nil } from "../../values/primitives/ANil.js";
import type { ExecOptions, ExecOptionsOverFrame } from "../../eval/generator-exec.js";
import { ANativeProcedure } from "../../values/primitives/ANativeProcedure.js";

/**
 * Execute Scheme source through the full default-env trampoline and return the
 * BOXED values (COMPLEX tier, execState — RULINGS.md R1): this file's
 * assertions read the result's own Scheme-print `.toString()` ("done"/"#t"),
 * a boxed-state concern, not the SIMPLE tier's plain-JS exit.
 */
// Dispatches to the internal live-frame seam when `options` carries an `env` (this file mixes
// bare default-env calls with a couple of `freshEnv()`-scoped ones), else the ordinary
// vocabulary-path `execState`.
async function execSource(src: string, options?: ExecOptions | ExecOptionsOverFrame): Promise<readonly unknown[]> {
  if (options && "env" in options && options.env !== undefined) {
    return (await execStateOverFrame(src, options)).values;
  }
  return (await execState(src, options)).values;
}

/**
 * Execute Scheme source through the full default-env trampoline and return the
 * unwrapped value of the LAST top-level expression (`exec` returns one result
 * per parsed form). Mirrors the `execSource` usage in evaluator.spec.ts.
 */
async function run(src: string): Promise<unknown> {
  const results = await execSource(src);
  return results[results.length - 1];
}

/**
 * Depth for every positive loop. 50k is comfortably past the ~10k pre-TCO
 * host-stack ceiling (so completion proves O(1)) and well under any heap
 * pressure (a collapsed loop retains single-digit MB regardless of depth).
 */
const DEPTH = 50000;

/** Per-test budget: one DEPTH loop runs in ~2s; the first test also pays the
 *  one-time lazy interpreter bootstrap. */
const T = 30000;

describe("tail-call optimization (R7RS §3.5)", () => {
  describe("positive — O(1) stack at 50k depth (would overflow pre-TCO)", () => {
    it(
      "self-recursion via define — `if` else arm is in tail position (§3.5)",
      async () => {
        // The shipped test covered this at 10k; 50k confirms genuine O(1) space.
        const r = await run(`(define (loop n) (if (= n 0) 'done (loop (- n 1)))) (loop ${DEPTH})`);
        expect(String(r)).toBe("done");
      },
      T,
    );

    it(
      "named-let — loop body is tail w.r.t. the (loop …) call site (§3.5; bounce path)",
      async () => {
        const r = await run(`(let loop ((i 0)) (if (= i ${DEPTH}) 'done (loop (+ i 1))))`);
        expect(String(r)).toBe("done");
      },
      T,
    );

    it(
      "mutual tail recursion — each call sits in the other's `if` tail arm (§3.5)",
      async () => {
        const r = await run(
          `(define (even? n) (if (= n 0) #t (odd? (- n 1))))
         (define (odd? n) (if (= n 0) #f (even? (- n 1))))
         (even? ${DEPTH})`,
        );
        // `even?` returns a boxed SchemeBool (#t), not the JS primitive `true`;
        // compare via String like the other cases. 50,000 is even.
        expect(String(r)).toBe("#t");
      },
      T,
    );

    it(
      "cond else arm — matched clause body inherits cond's tail flag (§3.5)",
      async () => {
        const r = await run(`(define (loop n) (cond ((= n 0) 'done) (else (loop (- n 1))))) (loop ${DEPTH})`);
        expect(String(r)).toBe("done");
      },
      T,
    );

    it(
      "cond non-else arm — a matched (test body) clause body is also tail (§3.5)",
      async () => {
        // Distinct from the else fallthrough: the recursive call sits in a clause
        // whose TEST matched, exercising evalCond's `evalBegin(exprs, ctx)` tail
        // path with the controlFlowResolve onResolve attached.
        const r = await run(`(define (loop n) (cond ((> n 0) (loop (- n 1))) (else 'done))) (loop ${DEPTH})`);
        expect(String(r)).toBe("done");
      },
      T,
    );

    it(
      "case arm — matched clause body inherits case's tail flag (§3.5)",
      async () => {
        const r = await run(`(define (loop n) (case n ((0) 'done) (else (loop (- n 1))))) (loop ${DEPTH})`);
        expect(String(r)).toBe("done");
      },
      T,
    );

    it(
      "cond => arm — the (proc test-value) application is tail (§3.5)",
      async () => {
        // R7RS §3.5 puts the `(proc test)` application of a `(test => proc)` clause
        // in tail position. Previously this evaluator applied proc via a nested
        // `run()` (host-stack growth → overflow at depth); applyArrowProc now routes
        // it through the trampoline bounce protocol, so reaching 50k proves the
        // application collapses. The proc tail-calls `loop`, so BOTH the `=>` apply
        // and the proc body must stay flat.
        const r = await run(
          `(define (loop n) (cond ((> n 0) => (lambda (_) (loop (- n 1)))) (else 'done))) (loop ${DEPTH})`,
        );
        expect(String(r)).toBe("done");
      },
      T,
    );

    it(
      "case => arm — the (proc key) application is tail (§3.5; R7RS §6.3)",
      async () => {
        // case's `(datums => proc)` mirrors cond's `=>` through the same helper.
        const r = await run(
          `(define (loop n) (case (> n 0) ((#t) => (lambda (_) (loop (- n 1)))) (else 'done))) (loop ${DEPTH})`,
        );
        expect(String(r)).toBe("done");
      },
      T,
    );

    it(
      "when body — last body expr is tail when test passes (§3.5)",
      async () => {
        const r = await run(`(define (loop n) (if (= n 0) 'done (when #t (loop (- n 1))))) (loop ${DEPTH})`);
        expect(String(r)).toBe("done");
      },
      T,
    );

    it(
      "unless body — last body expr is tail when test fails (§3.5)",
      async () => {
        const r = await run(`(define (loop n) (if (= n 0) 'done (unless #f (loop (- n 1))))) (loop ${DEPTH})`);
        expect(String(r)).toBe("done");
      },
      T,
    );

    it(
      "and last-expr — the final conjunct is in tail position (§3.5)",
      async () => {
        const r = await run(`(define (loop n) (if (= n 0) 'done (and #t (loop (- n 1))))) (loop ${DEPTH})`);
        expect(String(r)).toBe("done");
      },
      T,
    );

    it(
      "or last-expr — the final disjunct is in tail position (§3.5)",
      async () => {
        const r = await run(`(define (loop n) (if (= n 0) 'done (or #f (loop (- n 1))))) (loop ${DEPTH})`);
        expect(String(r)).toBe("done");
      },
      T,
    );

    it(
      "begin last-expr — only the final sequence expr is tail (§3.5)",
      async () => {
        const r = await run(`(define (loop n) (if (= n 0) 'done (begin 1 (loop (- n 1))))) (loop ${DEPTH})`);
        expect(String(r)).toBe("done");
      },
      T,
    );

    it(
      "let body — body inherits the let's tail flag (§3.5)",
      async () => {
        const r = await run(`(define (loop n) (if (= n 0) 'done (let ((m (- n 1))) (loop m)))) (loop ${DEPTH})`);
        expect(String(r)).toBe("done");
      },
      T,
    );

    it(
      "let* body — body inherits the let*'s tail flag (§3.5)",
      async () => {
        const r = await run(`(define (loop n) (if (= n 0) 'done (let* ((m (- n 1))) (loop m)))) (loop ${DEPTH})`);
        expect(String(r)).toBe("done");
      },
      T,
    );

    it(
      "letrec body — body inherits the letrec's tail flag (§3.5)",
      async () => {
        const r = await run(`(define (loop n) (if (= n 0) 'done (letrec ((m (- n 1))) (loop m)))) (loop ${DEPTH})`);
        expect(String(r)).toBe("done");
      },
      T,
    );

    it(
      "lambda immediately applied in tail position — the application site is tail (§3.5)",
      async () => {
        // `((lambda (m) (loop m)) (- n 1))` in the if-arm: the thunk application
        // is itself a tail call (evaluatePair tailCall path), and the thunk
        // body's `(loop m)` is tail too — collapse must reach through both.
        const r = await run(`(define (loop n) (if (= n 0) 'done ((lambda (m) (loop m)) (- n 1)))) (loop ${DEPTH})`);
        expect(String(r)).toBe("done");
      },
      T,
    );
  });

  describe("negative — NON-tail positions must NOT be over-optimized", () => {
    // Per the file header: argument-position / non-last-begin recursion is
    // heap-bound on this trampoline, so it cannot be asserted via toThrow (no
    // catchable error; deep depths fatally OOM the worker). The deterministic
    // over-optimization detector is SEMANTIC — a wrongly-collapsed tail call
    // would drop the pending frames and corrupt the accumulated result. Depths
    // here are kept at 5000: large enough to exercise many frames, far below
    // any OOM risk.

    it(
      "non-tail argument position — `(+ (sum (- n 1)) 1)` keeps every +1 frame (§3.5: operands are NOT tail)",
      async () => {
        // (sum n) === n iff all n stacked `(+ … 1)` frames executed. If the
        // recursive call had been (wrongly) tail-collapsed, those additions would
        // be dropped and the result would not equal n.
        const r = await run("(define (sum n) (if (= n 0) 0 (+ (sum (- n 1)) 1))) (sum 5000)");
        expect(String(r)).toBe("5000");
      },
      T,
    );

    it(
      "non-last expr in begin — trailing expr after the recursive call still runs, in order (§3.5: only begin's last is tail)",
      async () => {
        // The recursive (f (- n 1)) is the begin's FIRST (non-last ⇒ non-tail) expr;
        // the trailing (tick) must run after each recursion returns. A wrongly-collapsed
        // call would replace the frame mid-sequence and lose the 5000 trailing ticks.
        // Observation is a JS-side counter (the same NO-scheme-set! technique arrival's
        // own chibi-harness uses for its bookkeeping) — pure dataflow from the guest:
        // it just calls a bound function; the count lives in JS, not a mutated binding.
        let ticks = 0;
        const env = (await freshEnv()) as EnvWithInternals<ResolvingAmbient>;
        env.bind(
          "tick",
          new ANativeProcedure({
            name: "tick",
            arity: { min: 0, max: 0 },
            contract: undefined,
            impl: () => {
              ticks += 1;
              return nil;
            },
          }),
        );
        await execSource(
          `(define (f n) (if (= n 0) 0 (begin (f (- n 1)) (tick))))
         (f 5000)`,
          { env },
        );
        expect(ticks).toBe(5000);
      },
      T,
    );

    it(
      "non-last begin expr — sequencing intact, trailing expr is the returned value (§3.5)",
      async () => {
        // Depth-free sequencing check: if a tail call had replaced the begin slot
        // at `(side)`, the trailing `'after` would be lost. Asserting the result
        // is 'after proves the begin resumed past its first expr.
        const r = await run(
          `(define (side) 'ignored)
         (define (go) (begin (side) 'after))
         (go)`,
        );
        expect(String(r)).toBe("after");
      },
      T,
    );

    // ── cond/case `=>` arm: NOW tail-optimized (was the lone non-tail gap) ──
    //
    // R7RS §3.5 puts the `(proc test-value)` application of a `(test => proc)`
    // clause in tail position. This evaluator USED to apply `proc` via a nested
    // `run()` (host-stack growth → overflow at depth; the flaky vitest-worker
    // UNHANDLED-rejection / hang documented in this block's prior revision). That
    // is fixed: `applyArrowProc` routes the application through the same bounce
    // protocol as a normal application, so the `=>` apply collapses on the
    // trampoline. The POSITIVES above ("cond => arm" + "case => arm", both
    // reaching 50k) now assert it directly — and because the nested `run()` is
    // gone, they are stable siblings rather than worker-crashers.
  });

  describe("composition", () => {
    it(
      "TCO + provenance/tap — tap enter/exit stays balanced across a collapsed tail loop (popped frames still fire exit)",
      async () => {
        // The full arrival-chain provenance chain ((infer …) → AValue stamping →
        // lineage) needs the arrival-chain harness — out of scope for the
        // arrival-scheme slice (per the task's "test the arrival-scheme-only
        // slice" fallback). What this slice DOES validate is the load-bearing
        // claim the trampoline's tailCall handler makes: when the tail tower
        // collapses, each popped slot's `onResolve`/`onReject` (which is how
        // tap.exit and provenance stamping ride through — see evaluate()'s
        // pass-through `{ call }` and the controlFlowResolve war story) is
        // COMPOSED onto the replacement slot so it still fires when the tail
        // chain finally returns. If a collapsed frame dropped its exit, the tap
        // would see fewer exits than enters and lineage would break at every
        // tail step. We attach a counting tap and assert exact balance.
        let enters = 0;
        let exits = 0;
        let errorExits = 0;
        const tap = {
          enter(): unknown {
            enters++;
            return {};
          },
          exit(_inv: unknown, result: { value: unknown } | { error: unknown }): void {
            exits++;
            if ("error" in result) errorExits++;
          },
        };
        // A short tail loop so the tap fires a bounded, inspectable count. Each
        // iteration enters several Pairs ((loop …), (if …), (= …), (- …)); the
        // exact total is incidental — per-frame balance is the invariant.
        const results = await execSource("(define (loop n) (if (= n 0) 'done (loop (- n 1)))) (loop 200)", { tap });
        expect(String(results[results.length - 1])).toBe("done");
        expect(enters).toBeGreaterThan(200); // many frames per iteration, ≥1 per level
        // The load-bearing assertion: every enter on a (possibly later collapsed)
        // frame is matched by an exit. A dropped exit on a collapsed frame — the
        // bug the composed-onResolve machinery guards against — would make
        // exits < enters.
        expect(exits).toBe(enters);
        // The loop completes successfully, so no frame exits via the error path.
        expect(errorExits).toBe(0);
      },
      T,
    );

    it(
      "return-value correctness — a tail countdown returns the right symbol, not just 'no crash'",
      async () => {
        // O(1) space is necessary but not sufficient: the collapsed chain must
        // still thread the base-case value back to the original consumer (the
        // onResolve/onReject transfer in the trampoline tailCall handler). A bug
        // there returned `undefined` — the war story's "value lost in the orphaned
        // tower". Assert the exact symbol comes back.
        const r = await run("(define (cd n) (if (= n 0) 'liftoff (cd (- n 1)))) (cd 1000)");
        expect(String(r)).toBe("liftoff");
      },
      T,
    );

    it(
      "return-value correctness — a computed accumulator threads through a named-let tail loop (§3.5)",
      async () => {
        // Factorial-style accumulator proves the collapsed chain carries a
        // COMPUTED value (not just a constant sentinel). 5! = 120.
        const r = await run("(let loop ((n 5) (acc 1)) (if (= n 0) acc (loop (- n 1) (* acc n))))");
        expect(String(r)).toBe("120");
      },
      T,
    );

    // ── TCO + abort: covered in abort.test.ts; DELIBERATELY NOT duplicated here ──
    //
    // The task asked for a "tail-recursive-loop variant that aborts mid-flight"
    // (`(define (loop n) (loop (+ n 1)))` + a 50ms AbortController). It works
    // CORRECTLY — verified in isolation: TCO keeps the loop flat, the trampoline
    // reaches its TICK abort-check cadence, and the 50ms budget cancels it
    // cleanly with an AbortError (NOT a "Maximum call stack" overflow, which is
    // the pre-TCO failure mode abort.test.ts's war story documents).
    //
    // It is OMITTED from this file because it destabilizes the vitest worker
    // when run after the 18 preceding heavy cases. Bisected precisely:
    //   • the abort test PASSES alone and PASSES after the positive cases when
    //     it is the only composition test;
    //   • but in the full file it HANGS the forks worker at 0% CPU — the
    //     infinite bounce-loop's `await Promise.resolve()` microtask churn,
    //     after accumulated load, starves the `setTimeout(50ms)` macrotask so
    //     `ctrl.abort()` never fires and the trampoline never reaches its abort
    //     check. (The same program runs to abort cleanly in a standalone Node
    //     process — it is a vitest-forks-worker timer-starvation artifact, not
    //     an evaluator bug.) Two consecutive infinite-loop aborts wedge the
    //     worker even faster.
    // Keeping it would jeopardize "the full suite stays green" for coverage that
    // already exists: abort.test.ts exercises the AbortSignal budget end-to-end
    // (infinite-loop abort, pre-aborted signal, reason preservation, mid-run
    // abort). The TCO-specific angle — that abort now composes with a genuine
    // tail loop rather than only `(do () (#f))` — is noted here and in
    // abort.test.ts's war story. If the worker-starvation interaction is ever
    // resolved, restore the single-run abort assertion drafted in git history.
  });
});
