// Chibi harness v2 — harness-capability.ts
// (docs/test-suite-architecture.md F4).
//
// A real `EnvCapability`, same shape v1's chibi-harness.ts uses (dogfooding the production
// env-assembly model) — but the comparison moves ENTIRELY into scheme (P4/P9/P7,
// `docs/PRINCIPLES.md:85-160`):
//
//   - `test`/`test-assert`/`test-error`/`test-values`/`test-numeric-syntax` are macros that
//     defer BOTH operands as thunks (`(lambda () expected)` / `(lambda () expr)`) — v1 evaluated
//     `expected` eagerly (chibi-harness.ts:242-247), losing attribution when the expected
//     expression itself doors.
//   - `js-run-test` (native) invokes each thunk via `applyCallback` (the single reverse-membrane
//     seam), catching each phase separately (`expected-eval` / `actual-eval`), then invokes a
//     SCHEME-DEFINED comparator (also via `applyCallback`) on the two BOXED results — the shape
//     already drafted, unused, at v1's `chibi-harness.ts:224-233` (`approx-equal?`), now wired
//     as the actual comparator instead of the JS-side `valueOf`/`String` duck-tolerance
//     (`chibi-harness.ts:98-111`) that was the named P4 offender.
//   - Only the boolean verdict crosses back out of the comparator call; failure reprs use the
//     class-owned print protocol (`arrival/print`, values/print.ts), never `String(scheme value)`.
//   - The comparator lambda is fetched via a second native hook (`js-register-comparator`),
//     called once at the END of the prelude (`(js-register-comparator chibi-test-equal?)`) —
//     capability.ts's apply() binds `symbols` BEFORE evaluating `prelude`, so this hook is
//     already live by the time the prelude reaches that call. This is the harness's own
//     bookkeeping (a JS closure holding the fetched lambda), not scheme `set!`.
//
// `test-begin`/`test-end` are deliberately NOT bound here: the manifest (manifest.ts) already
// derives section nesting structurally at collection time, so these forms become
// `section-begin`/`section-end` steps the runner never executes — no runtime group-stack is
// needed (unlike v1's `js-test-begin`/`js-test-end`).
import { testCallCtx } from "../../../run/CallCtx.js";
import type { CallCtx } from "../../../run/CallCtx.js";
import { EnvCapability } from "../../../common/capability.js";
import { ACallable, applyCallback } from "../../../values/primitives/ACallable.js";
import { ABool } from "../../../values/primitives/ABool.js";
import { type AVoid, theVoid } from "../../../values/primitives/AVoid.js";
import { printValue } from "../../../values/print.js";
import type { SchemeValue } from "../../../values/types.js";

export type OutcomePhase = "expected-eval" | "actual-eval" | "compare";

export type StepOutcome =
  | { kind: "pass" }
  | { kind: "fail"; expectedRepr: string; actualRepr: string }
  | {
      kind: "error";
      phase: OutcomePhase | "budget" | "block-aborted" | "setup-failed";
      message: string;
      atLine?: number;
    };

/** Outcomes accumulated by `js-run-test` calls since the last `drain()`. One `exec()` call may
 *  produce several (a block form containing k nested `(test …)` calls fires js-run-test k
 *  times in corpus order before returning). */
export interface OutcomeSink {
  drain(): StepOutcome[];
}

/** Build a fresh v2 harness: its capability closes over a private outcome queue + the
 *  fetched comparator lambda. One harness per `CorpusRunner`. */
export function createChibiHarnessV2(): { capability: EnvCapability; sink: OutcomeSink } {
  const queue: StepOutcome[] = [];
  let comparator: ACallable | undefined; // the scheme `chibi-test-equal?` lambda, fetched once (see prelude)

  const capability = EnvCapability.define("test/harness-v2", {
    symbols: (symbol, z) => ({
      // The comparator lambda registers itself here once, at prelude end — see the module
      // header. `z.lambda` is type-level only for a native def (native impls receive raw
      // scheme values, unvalidated; see common/symbols/native.ts) — the runtime value is the
      // boxed `ALambda` `chibi-test-equal?` defines to, invoked later via `applyCallback`.
      "js-register-comparator": symbol.native`js-register-comparator: fetch the scheme comparator lambda once`(
        { input: [z.lambda], output: [z.undefinedResult] },
        (fn): AVoid => {
          comparator = fn;
          return theVoid;
        },
      ),

      // The runner: invoke expected-thunk and actual-thunk (each its own catch, so a door in
      // EITHER is attributed to the right phase), then compare the two BOXED results entirely
      // in scheme. Only the boolean verdict crosses back (§5); reprs are computed here (failure
      // only) via the class-owned print protocol, never `String(...)`.
      //
      // Dual pass (M5): plain-function `this: CallCtx` (never an arrow — W0 / arrow-fn trap).
      // Thunks and the comparator MUST see the enclosing run's RunContext (strict / meter /
      // channels). Bare `testCallCtx()` is CONSTANT_CTX (`strict: false`) — that silently
      // collapsed Pass A to loose for every test-error/test form, which is why car/cdr-empty
      // lived as permanent EXPECTED_FAILURES under "harness never passes strict". Thread
      // `this.runCtx` so CorpusRunner.create(manifest, { strict: true }) is load-bearing.
      "js-run-test":
        symbol.native`js-run-test: run expected/actual thunks, compare via the scheme comparator, sink the outcome`(
          { input: [z.schemeValue, z.lambda, z.lambda], output: [z.undefinedResult] },
          async function (this: CallCtx, _name, expectedThunk, actualThunk): Promise<AVoid> {
            // One CallCtx per js-run-test fire — same run as the outer form (Pass A or loose).
            const thunkCtx = testCallCtx({ runCtx: this.runCtx });
            let expected: SchemeValue;
            try {
              expected = (await applyCallback(expectedThunk, [], thunkCtx)) as SchemeValue;
            } catch (e) {
              queue.push({ kind: "error", phase: "expected-eval", message: describeError(e) });
              return theVoid;
            }
            let actual: SchemeValue;
            try {
              actual = (await applyCallback(actualThunk, [], thunkCtx)) as SchemeValue;
            } catch (e) {
              queue.push({ kind: "error", phase: "actual-eval", message: describeError(e) });
              return theVoid;
            }
            try {
              if (comparator === undefined) {
                throw new Error(
                  "chibi harness v2: comparator not registered (prelude did not run js-register-comparator)",
                );
              }
              const verdict = await applyCallback(comparator, [expected, actual], thunkCtx);
              const pass = verdict instanceof ABool ? verdict.value : Boolean(verdict);
              if (pass) queue.push({ kind: "pass" });
              else queue.push({ kind: "fail", expectedRepr: printValue(expected), actualRepr: printValue(actual) });
            } catch (e) {
              queue.push({ kind: "error", phase: "compare", message: describeError(e) });
            }
            return theVoid;
          },
        ),
    }),

    prelude: `
    ;; The comparator — chibi's approximate float equality, structurally recursive over
    ;; pairs/vectors, falling back to the base equal? everywhere else. This is the "already
    ;; drafted, unused" shape from v1 (chibi-harness.ts:220-233), now wired as the ACTUAL
    ;; comparator instead of a JS-side valueOf/String duck-tolerance.
    (define (chibi-test-equal? a b)
      (cond
        ((and (number? a) (number? b))
         (if (and (exact? a) (exact? b))
             (equal? a b)
             ;; Equal infinities first: (- +inf.0 +inf.0) is +nan.0, and (< +nan.0 _) is
             ;; always #f, so the epsilon-diff below always "fails" two equal infinities
             ;; even though they print identically. = compares infinities correctly
             ;; (R7RS numeric equality), so route through it before the subtraction.
             (or (= a b)
                 (< (abs (- a b)) (+ 1e-10 (* 1e-6 (max (abs a) (abs b))))))))
        ((and (pair? a) (pair? b))
         (and (chibi-test-equal? (car a) (car b))
              (chibi-test-equal? (cdr a) (cdr b))))
        ((and (vector? a) (vector? b) (= (vector-length a) (vector-length b)))
         (let loop ((i 0))
           (or (>= i (vector-length a))
               (and (chibi-test-equal? (vector-ref a i) (vector-ref b i))
                    (loop (+ i 1))))))
        (else (equal? a b))))
    (js-register-comparator chibi-test-equal?)

    ;; test — defers BOTH expected and expr as thunks (v1 evaluated expected eagerly).
    (define-syntax test
      (syntax-rules ()
        ((test name expected expr)
         (js-run-test name (lambda () expected) (lambda () expr)))
        ((test expected expr)
         (js-run-test 'expr (lambda () expected) (lambda () expr)))))

    (define-syntax test-assert
      (syntax-rules ()
        ((test-assert expr)
         (test-assert 'expr expr))
        ((test-assert name expr)
         (test name #t expr))))

    ;; test-error — expects expr to raise; both arms are deferred thunks through the SAME
    ;; js-run-test hook (no separate pass/fail/error callback natives, unlike v1).
    (define-syntax test-error
      (syntax-rules ()
        ((test-error expr)
         (test-error 'expr expr))
        ((test-error name expr)
         (js-run-test name (lambda () 'error)
                      (lambda () (guard (err (#t 'error)) expr 'no-error))))))

    ;; test-values — rewrites to test, which now defers both sides itself.
    (define-syntax test-values
      (syntax-rules ()
        ((test-values expected expr)
         (test (call-with-values (lambda () expected) list)
               (call-with-values (lambda () expr) list)))))

    ;; test-numeric-syntax — the read-half-only shim (no string ports; see r7rs/parse's
    ;; string->number, the same parse the reader performs for a numeric token). The corpus
    ;; itself REDEFINES this macro later (r7rs-tests.scm's own "Numeric syntax" section, using
    ;; real ports) — that redefinition is executed like any other setup form and will shadow
    ;; this one from that point on; the resulting cascade is expected, documented red (see the
    ;; spec's top-failure-signature report, not a harness bug).
    (define-syntax test-numeric-syntax
      (syntax-rules ()
        ((test-numeric-syntax str expect strs ...)
         (test str expect (string->number str)))))
  `,
  });

  return {
    capability,
    sink: {
      drain(): StepOutcome[] {
        const out = queue.slice();
        queue.length = 0;
        return out;
      },
    },
  };
}

function describeError(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
