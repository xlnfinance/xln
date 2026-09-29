/**
 * Tests for the generator-based evaluator using real scheme types
 */
import { beforeEach, describe, expect, it } from "vitest";
import { theVoid } from "../../values/primitives/AVoid.js";
import { CONSTANT_CTX } from "../../run/RunContext.js";
import { type EnvWithInternals, ResolvingAmbient } from "../../env/AmbientRuntime.js";
import run from "../../eval/evaluator.js";
// `execExpr` is the COMPLEX-tier form-at-a-time entry (SchemeValue in, boxed
// SchemeValue out, never unwrapped) — the direct replacement for the retired
// evaluator-internal `exec` wrapper this spec used to import (byte-identical
// glass-env behavior; see RULINGS.md R1).
//
// String-based exec with the full default env (provides `=`, `-`, etc.) — used
// only by the tail-call optimization test, which exercises the trampoline's
// cross-`run()` recursion shape and needs real `if`/`=`/`-` rather than the
// minimal hand-rolled `env` above.
import { execExprOverFrame, exec as execSource } from "../../eval/generator-exec.js";
import { ASymbol } from "../../values/primitives/ASymbol.js";
import { AExact } from "../../values/primitives/AExact.js";
import { AInexact } from "../../values/primitives/AInexact.js";
import { schemeTrue, schemeFalse } from "../../values/primitives/ABool.js";
import { AString } from "../../values/primitives/AString.js";
import { APair } from "../../values/primitives/APair.js";
import { nil } from "../../values/primitives/ANil.js";
import { ALambda, hostFnToCallable } from "../../values/primitives/ACallable.js";
import { ANativeProcedure } from "../../values/primitives/ANativeProcedure.js";
import { EMPTY_PROVENANCE } from "../../values/primitives/AValue.js";
import { type SchemeValue } from "../../values/types.js";

describe("Generator Evaluator with Real Scheme Types", () => {
  // `ResolvingAmbient`, not the plain `AmbientRuntime` its raw evaluator-level content
  // would otherwise need: `execExprOverFrame(code, { env })` types `env` as `SchemeEnv` (V2,
  // arrival-environment-privatization.md §II.3/D2), which `ResolvingAmbient`
  // structurally satisfies and plain `AmbientRuntime` does not — a byte-identical stand-in
  // here (no resolver ever registered), see the file header for why this test builds a
  // hand-rolled env instead of the default base.
  let env: EnvWithInternals<ResolvingAmbient>;

  beforeEach(() => {
    // Note: SchemeExact has num/denom (for rationals), not value
    // RE-PINNED (one-number rework, RATIO — docs/design-history/arrival-one-number-rework.md
    // §2.1): AExact's payload is a safe-int `number` now, not `bigint` — this hand-rolled test
    // env's arithmetic helpers ported bigint accumulators/comparisons to plain number ones
    // (`0`→`0`, `BigInt(...)`→direct number use, the dead `typeof arg === "bigint"` arm
    // dropped since a raw host bigint is now an opaque pass-through the interpreter never
    // hands this test helper — §2.3).
    // W8: ambient holds ACallable values only — bare host fns refused.
    const contour = (
      name: string,
      arity: { min: number; max: number | null },
      impl: (args: readonly SchemeValue[]) => SchemeValue,
    ) =>
      new ANativeProcedure({
        name,
        arity,
        contract: undefined,
        impl: (args) => impl(args),
      });
    const numOf = (a: SchemeValue): number =>
      a instanceof AExact ? a.num : a instanceof AInexact ? a.real : (a as unknown as number);
    const bool = (b: boolean) => (b ? schemeTrue : schemeFalse);
    env = ResolvingAmbient.root("test-env", {
      "+": contour("+", { min: 0, max: null }, (args) => {
        let result = 0;
        let hasInexact = false;
        for (const arg of args) {
          if (arg instanceof AExact) {
            result += arg.num;
          } else if (arg instanceof AInexact) {
            hasInexact = true;
            result += Math.floor(arg.real);
          } else if (typeof arg === "number") {
            hasInexact = true;
            result += Math.floor(arg);
          }
        }
        return hasInexact ? new AInexact(result) : new AExact(result);
      }),
      "-": contour("-", { min: 0, max: null }, (args) => {
        if (args.length === 0) return new AExact(0);
        let result = numOf(args[0]!);
        if (args.length === 1) return new AExact(-result);
        for (let i = 1; i < args.length; i++) result -= numOf(args[i]!);
        return new AExact(result);
      }),
      "*": contour("*", { min: 0, max: null }, (args) => {
        let result = 1;
        for (const arg of args) result *= numOf(arg);
        return new AExact(result);
      }),
      "/": contour("/", { min: 2, max: 2 }, ([a, b]) => new AInexact(numOf(a!) / numOf(b!))),
      "<": contour("<", { min: 2, max: 2 }, ([a, b]) => bool(numOf(a!) < numOf(b!))),
      ">": contour(">", { min: 2, max: 2 }, ([a, b]) => bool(numOf(a!) > numOf(b!))),
      "<=": contour("<=", { min: 2, max: 2 }, ([a, b]) => bool(numOf(a!) <= numOf(b!))),
      ">=": contour(">=", { min: 2, max: 2 }, ([a, b]) => bool(numOf(a!) >= numOf(b!))),
      "=": contour("=", { min: 2, max: 2 }, ([a, b]) => bool(numOf(a!) === numOf(b!))),
      list: contour("list", { min: 0, max: null }, (args) => APair.fromArray(CONSTANT_CTX, args, false)),
      car: contour("car", { min: 1, max: 1 }, ([pair]) => (pair as APair<any, any>).car),
      cdr: contour("cdr", { min: 1, max: 1 }, ([pair]) => (pair as APair<any, any>).cdr),
      cons: contour("cons", { min: 2, max: 2 }, ([a, b]) => new APair(a!, b!)),
      "null?": contour("null?", { min: 1, max: 1 }, ([x]) =>
        bool(
          x === nil ||
            (x !== null && typeof x === "object" && (x as { toString?: () => string }).toString?.() === "()"),
        ),
      ),
      not: contour("not", { min: 1, max: 1 }, ([x]) => bool(x === schemeFalse || x === nil)),
      "#t": schemeTrue,
      "#f": schemeFalse,
    }) as EnvWithInternals<ResolvingAmbient>;
  });

  describe("run() trampoline", () => {
    it("should run a simple generator to completion", async () => {
      function* simple() {
        yield 1;
        yield 2;
        return 3;
      }
      const result = await run(simple());
      expect(result).toBe(3);
    });

    it("should await yielded promises", async () => {
      function* withPromise() {
        const a = yield Promise.resolve(10);
        const b = yield Promise.resolve(20);
        return (a as number) + (b as number);
      }
      const result = await run(withPromise());
      expect(result).toBe(30);
    });

    it("should handle errors from promises", async () => {
      function* withError() {
        yield Promise.reject(new Error("test error"));
        return "should not reach";
      }
      await expect(run(withError())).rejects.toThrow("test error");
    });
  });

  describe("evaluate()", () => {
    it("should evaluate atoms to themselves", async () => {
      expect(await execExprOverFrame(new AExact(42), { env })).toEqual(new AExact(42));
      const hello = new AString("hello");
      expect(await execExprOverFrame(hello, { env })).toBe(hello);
      expect(await execExprOverFrame(nil, { env })).toBe(nil);
    });

    it("should look up symbols in environment", async () => {
      env.bind("x", new AExact(10));
      env.bind("y", new AExact(20));
      expect(await execExprOverFrame(new ASymbol("x"), { env })).toEqual(new AExact(10));
      expect(await execExprOverFrame(new ASymbol("y"), { env })).toEqual(new AExact(20));
    });

    it("should evaluate simple function calls", async () => {
      const code = APair.fromArray(
        CONSTANT_CTX,
        [new ASymbol("+"), new AExact(1), new AExact(2), new AExact(3)],
        false,
      );
      const result = await execExprOverFrame(code, { env });
      expect(result).toEqual(new AExact(6));
    });

    it("should evaluate nested function calls", async () => {
      const code = APair.fromArray(
        CONSTANT_CTX,
        [
          new ASymbol("+"),
          APair.fromArray(CONSTANT_CTX, [new ASymbol("*"), new AExact(2), new AExact(3)], false),
          APair.fromArray(CONSTANT_CTX, [new ASymbol("*"), new AExact(4), new AExact(5)], false),
        ],
        false,
      );
      const result = await execExprOverFrame(code, { env });
      expect(result).toEqual(new AExact(26)); // 6 + 20
    });

    // INVARIANT: a host-fn-as-callable (hostFnToCallable → ARosettaProcedure) that returns a
    // promise is awaited and its result boxes through the reverse membrane.
    // W8: bare env-resident host fns are doored; mint via hostFnToCallable.
    it("should handle JS functions that return promises", async () => {
      env.bind(
        "async-add",
        hostFnToCallable(
          CONSTANT_CTX,
          async (a: unknown, b: unknown) => {
            await new Promise((r) => setTimeout(r, 1));
            return (a as number) + (b as number);
          },
          EMPTY_PROVENANCE,
        ),
      );

      const code = APair.fromArray(CONSTANT_CTX, [new ASymbol("async-add"), new AExact(10), new AExact(20)], false);
      const result = await execExprOverFrame(code, { env });
      expect((result as AExact)["arrival/toJS"]()).toBe(30);
    });
  });

  describe("special forms", () => {
    describe("quote", () => {
      it("should return its argument unevaluated", async () => {
        // (quote (1 2 3))
        const code = APair.fromArray(
          CONSTANT_CTX,
          [new ASymbol("quote"), APair.fromArray(CONSTANT_CTX, [new AExact(1), new AExact(2), new AExact(3)], false)],
          false,
        );
        const result = (await execExprOverFrame(code, { env })) as APair<any, any>;
        expect(result.car).toEqual(new AExact(1));
        expect((result.cdr as APair<any, any>).car).toEqual(new AExact(2));
      });

      it("should quote a symbol", async () => {
        // (quote x)
        const code = APair.fromArray(CONSTANT_CTX, [new ASymbol("quote"), new ASymbol("x")], false);
        const result = (await execExprOverFrame(code, { env })) as ASymbol;
        expect(result.__name__).toBe("x");
      });
    });

    describe("quasiquote", () => {
      it("should return simple list unevaluated", async () => {
        // `(1 2 3)
        const code = APair.fromArray(
          CONSTANT_CTX,
          [
            new ASymbol("quasiquote"),
            APair.fromArray(CONSTANT_CTX, [new AExact(1), new AExact(2), new AExact(3)], false),
          ],
          false,
        );
        const result = (await execExprOverFrame(code, { env })) as APair<any, any>;
        expect(result.car).toEqual(new AExact(1));
      });

      it("should evaluate unquoted expressions", async () => {
        // `(1 ,(+ 1 1) 3)
        env.bind("x", new AExact(10));
        const code = APair.fromArray(
          CONSTANT_CTX,
          [
            new ASymbol("quasiquote"),
            APair.fromArray(
              CONSTANT_CTX,
              [
                new AExact(1),
                APair.fromArray(CONSTANT_CTX, [new ASymbol("unquote"), new ASymbol("x")], false),
                new AExact(3),
              ],
              false,
            ),
          ],
          false,
        );
        const result = (await execExprOverFrame(code, { env })) as APair<any, any>;
        expect(result.car).toEqual(new AExact(1));
        expect((result.cdr as APair<any, any>).car).toEqual(new AExact(10));
        expect(((result.cdr as APair<any, any>).cdr as APair<any, any>).car).toEqual(new AExact(3));
      });

      it("should handle unquote-splicing", async () => {
        // `(1 ,@(list 2 3) 4)
        const code = APair.fromArray(
          CONSTANT_CTX,
          [
            new ASymbol("quasiquote"),
            APair.fromArray(
              CONSTANT_CTX,
              [
                new AExact(1),
                APair.fromArray(
                  CONSTANT_CTX,
                  [
                    new ASymbol("unquote-splicing"),
                    APair.fromArray(CONSTANT_CTX, [new ASymbol("list"), new AExact(2), new AExact(3)], false),
                  ],
                  false,
                ),
                new AExact(4),
              ],
              false,
            ),
          ],
          false,
        );
        const result = await execExprOverFrame(code, { env });
        const arr = (result as APair<any, any>).to_array();
        expect(arr.length).toBe(4);
      });
    });

    describe("if", () => {
      it("should evaluate then branch when condition is nil (Scheme: only #f is false)", async () => {
        const code = APair.fromArray(CONSTANT_CTX, [new ASymbol("if"), nil, new AExact(1), new AExact(2)], false);
        expect(await execExprOverFrame(code, { env })).toEqual(new AExact(1));
      });

      it("should return undefined when no else branch and condition is false", async () => {
        const code = APair.fromArray(CONSTANT_CTX, [new ASymbol("if"), schemeFalse, new AExact(1)], false);
        expect(await execExprOverFrame(code, { env })).toBe(theVoid);
      });

      it("should evaluate nested if expressions", async () => {
        const code = APair.fromArray(
          CONSTANT_CTX,
          [
            new ASymbol("if"),
            APair.fromArray(CONSTANT_CTX, [new ASymbol("<"), new AExact(1), new AExact(2)], false),
            APair.fromArray(
              CONSTANT_CTX,
              [
                new ASymbol("if"),
                APair.fromArray(CONSTANT_CTX, [new ASymbol(">"), new AExact(3), new AExact(2)], false),
                new AExact(100),
                new AExact(200),
              ],
              false,
            ),
            new AExact(300),
          ],
          false,
        );
        expect(await execExprOverFrame(code, { env })).toEqual(new AExact(100));
      });
    });

    describe("begin", () => {
      it("should return undefined for empty begin", async () => {
        // (begin)
        const code = APair.fromArray(CONSTANT_CTX, [new ASymbol("begin")], false);
        expect(await execExprOverFrame(code, { env })).toBe(theVoid);
      });

      it("should execute side effects", async () => {
        let sideEffect = 0;
        env.bind(
          "inc!",
          new ANativeProcedure({
            name: "inc!",
            arity: { min: 0, max: 0 },
            contract: undefined,
            impl: () => {
              sideEffect++;
              return new AExact(sideEffect);
            },
          }),
        );

        // (begin (inc!) (inc!) (inc!))
        const code = APair.fromArray(
          CONSTANT_CTX,
          [
            new ASymbol("begin"),
            APair.fromArray(CONSTANT_CTX, [new ASymbol("inc!")], false),
            APair.fromArray(CONSTANT_CTX, [new ASymbol("inc!")], false),
            APair.fromArray(CONSTANT_CTX, [new ASymbol("inc!")], false),
          ],
          false,
        );
        const result = await execExprOverFrame(code, { env });
        expect(result).toEqual(new AExact(3));
        expect(sideEffect).toBe(3);
      });
    });

    describe("define", () => {
      it("should define a simple variable", async () => {
        // (define x 42)
        const code = APair.fromArray(CONSTANT_CTX, [new ASymbol("define"), new ASymbol("x"), new AExact(42)], false);
        await execExprOverFrame(code, { env });
        expect(env._lookupWithResolvers("x")).toEqual(new AExact(42));
      });

      it("should evaluate the value expression", async () => {
        // (define x (+ 1 2))
        const code = APair.fromArray(
          CONSTANT_CTX,
          [
            new ASymbol("define"),
            new ASymbol("x"),
            APair.fromArray(CONSTANT_CTX, [new ASymbol("+"), new AExact(1), new AExact(2)], false),
          ],
          false,
        );
        await execExprOverFrame(code, { env });
        expect(env._lookupWithResolvers("x")).toEqual(new AExact(3));
      });

      it("should define a function with shorthand syntax", async () => {
        // (define (add a b) (+ a b))
        const code = APair.fromArray(
          CONSTANT_CTX,
          [
            new ASymbol("define"),
            APair.fromArray(CONSTANT_CTX, [new ASymbol("add"), new ASymbol("a"), new ASymbol("b")], false),
            APair.fromArray(CONSTANT_CTX, [new ASymbol("+"), new ASymbol("a"), new ASymbol("b")], false),
          ],
          false,
        );
        await execExprOverFrame(code, { env });
        const add = env._lookupWithResolvers("add");
        // Scheme lambdas are ALambda values (callable-as-value) carrying a mutable __name__.
        expect(add).toBeInstanceOf(ALambda);
        expect((add as { __name__?: string }).__name__).toBe("add");
      });
    });

    // set! removed — lexical variable rebinding is doored under the purity invariant
    // (r7rs/binding); arrival is pure dataflow, so there is no rebind form to test.

    describe("lambda", () => {
      it("should capture closure environment", async () => {
        // (define a 10)
        // ((lambda (x) (+ a x)) 5)
        await execExprOverFrame(
          APair.fromArray(CONSTANT_CTX, [new ASymbol("define"), new ASymbol("a"), new AExact(10)], false),
          { env },
        );
        const code = APair.fromArray(
          CONSTANT_CTX,
          [
            APair.fromArray(
              CONSTANT_CTX,
              [
                new ASymbol("lambda"),
                APair.fromArray(CONSTANT_CTX, [new ASymbol("x")], false),
                APair.fromArray(CONSTANT_CTX, [new ASymbol("+"), new ASymbol("a"), new ASymbol("x")], false),
              ],
              false,
            ),
            new AExact(5),
          ],
          false,
        );
        const result = await execExprOverFrame(code, { env });
        expect(result).toEqual(new AExact(15));
      });

      it("should handle rest parameters", async () => {
        // ((lambda args args) 1 2 3)
        const code = APair.fromArray(
          CONSTANT_CTX,
          [
            APair.fromArray(CONSTANT_CTX, [new ASymbol("lambda"), new ASymbol("args"), new ASymbol("args")], false),
            new AExact(1),
            new AExact(2),
            new AExact(3),
          ],
          false,
        );
        const result = (await execExprOverFrame(code, { env })) as APair<any, any>;
        expect(result.to_array()).toEqual([new AExact(1), new AExact(2), new AExact(3)]);
      });
    });

    describe("let", () => {
      it("should use parallel binding semantics", async () => {
        // (let ((x 1) (y x)) y) - should fail because x isn't bound yet
        env.bind("x", new AExact(100));
        const code = APair.fromArray(
          CONSTANT_CTX,
          [
            new ASymbol("let"),
            APair.fromArray(
              CONSTANT_CTX,
              [
                APair.fromArray(CONSTANT_CTX, [new ASymbol("x"), new AExact(1)], false),
                APair.fromArray(CONSTANT_CTX, [new ASymbol("y"), new ASymbol("x")], false),
              ],
              false,
            ),
            new ASymbol("y"),
          ],
          false,
        );
        // y should be 100 (outer x), not 1 (inner x)
        expect(await execExprOverFrame(code, { env })).toEqual(new AExact(100));
      });
    });

    describe("and", () => {
      it("should return true for empty and", async () => {
        // (and) ⇒ #t (R7RS §6.3): the boxed schemeTrue singleton IS the Scheme #t.
        const code = APair.fromArray(CONSTANT_CTX, [new ASymbol("and")], false);
        expect(await execExprOverFrame(code, { env })).toBe(schemeTrue);
      });

      it("should short-circuit on false", async () => {
        let called = false;
        env.bind(
          "side-effect",
          new ANativeProcedure({
            name: "side-effect",
            arity: { min: 0, max: 0 },
            contract: undefined,
            impl: () => {
              called = true;
              return schemeTrue;
            },
          }),
        );
        // (and #f (side-effect))
        const code = APair.fromArray(
          CONSTANT_CTX,
          [new ASymbol("and"), schemeFalse, APair.fromArray(CONSTANT_CTX, [new ASymbol("side-effect")], false)],
          false,
        );
        expect(await execExprOverFrame(code, { env })).toBe(schemeFalse);
        expect(called).toBe(false);
      });

      it("should return last value if all true", async () => {
        // (and 1 2 3)
        const code = APair.fromArray(
          CONSTANT_CTX,
          [new ASymbol("and"), new AExact(1), new AExact(2), new AExact(3)],
          false,
        );
        expect(await execExprOverFrame(code, { env })).toEqual(new AExact(3));
      });
    });

    describe("or", () => {
      it("should return false for empty or", async () => {
        // (or) ⇒ #f (R7RS §6.3): the boxed schemeFalse singleton IS the Scheme #f.
        const code = APair.fromArray(CONSTANT_CTX, [new ASymbol("or")], false);
        expect(await execExprOverFrame(code, { env })).toBe(schemeFalse);
      });

      it("should short-circuit on true", async () => {
        let called = false;
        env.bind(
          "side-effect",
          new ANativeProcedure({
            name: "side-effect",
            arity: { min: 0, max: 0 },
            contract: undefined,
            impl: () => {
              called = true;
              return schemeFalse;
            },
          }),
        );
        // (or 1 (side-effect))
        const code = APair.fromArray(
          CONSTANT_CTX,
          [new ASymbol("or"), new AExact(1), APair.fromArray(CONSTANT_CTX, [new ASymbol("side-effect")], false)],
          false,
        );
        expect(await execExprOverFrame(code, { env })).toEqual(new AExact(1));
        expect(called).toBe(false);
      });

      it("should return last value if all false", async () => {
        // (or #f #f 0) - 0 is truthy in Scheme
        const code = APair.fromArray(CONSTANT_CTX, [new ASymbol("or"), schemeFalse, schemeFalse, new AExact(0)], false);
        expect(await execExprOverFrame(code, { env })).toEqual(new AExact(0));
      });
    });

    describe("cond", () => {
      it("should evaluate else clause when nothing matches", async () => {
        // (cond ((> 1 2) 'no) (else 'yes))
        const code = APair.fromArray(
          CONSTANT_CTX,
          [
            new ASymbol("cond"),
            APair.fromArray(
              CONSTANT_CTX,
              [
                APair.fromArray(CONSTANT_CTX, [new ASymbol(">"), new AExact(1), new AExact(2)], false),
                APair.fromArray(CONSTANT_CTX, [new ASymbol("quote"), new ASymbol("no")], false),
              ],
              false,
            ),
            APair.fromArray(
              CONSTANT_CTX,
              [new ASymbol("else"), APair.fromArray(CONSTANT_CTX, [new ASymbol("quote"), new ASymbol("yes")], false)],
              false,
            ),
          ],
          false,
        );
        const result = (await execExprOverFrame(code, { env })) as ASymbol;
        expect(result.__name__).toBe("yes");
      });

      it("should return test value when no expressions", async () => {
        // (cond (5)) => 5
        const code = APair.fromArray(
          CONSTANT_CTX,
          [new ASymbol("cond"), APair.fromArray(CONSTANT_CTX, [new AExact(5)], false)],
          false,
        );
        expect(await execExprOverFrame(code, { env })).toEqual(new AExact(5));
      });

      // W8: hostFnToCallable mints ARosettaProcedure (scheme args → JS, result boxes back).
      it("should handle => syntax", async () => {
        // (cond ((+ 1 2) => double))
        env.bind(
          "double",
          hostFnToCallable(CONSTANT_CTX, (x: unknown) => (x as number) * 2, EMPTY_PROVENANCE),
        );
        const code = APair.fromArray(
          CONSTANT_CTX,
          [
            new ASymbol("cond"),
            APair.fromArray(
              CONSTANT_CTX,
              [
                APair.fromArray(CONSTANT_CTX, [new ASymbol("+"), new AExact(1), new AExact(2)], false),
                new ASymbol("=>"),
                new ASymbol("double"),
              ],
              false,
            ),
          ],
          false,
        );
        expect(((await execExprOverFrame(code, { env })) as AExact)["arrival/toJS"]()).toBe(6);
      });
    });

    describe("case", () => {
      it("should use else when no match", async () => {
        // (case 5 ((1) 'one) ((2) 'two) (else 'other))
        const code = APair.fromArray(
          CONSTANT_CTX,
          [
            new ASymbol("case"),
            new AExact(5),
            APair.fromArray(
              CONSTANT_CTX,
              [
                APair.fromArray(CONSTANT_CTX, [new AExact(1)], false),
                APair.fromArray(CONSTANT_CTX, [new ASymbol("quote"), new ASymbol("one")], false),
              ],
              false,
            ),
            APair.fromArray(
              CONSTANT_CTX,
              [
                APair.fromArray(CONSTANT_CTX, [new AExact(2)], false),
                APair.fromArray(CONSTANT_CTX, [new ASymbol("quote"), new ASymbol("two")], false),
              ],
              false,
            ),
            APair.fromArray(
              CONSTANT_CTX,
              [new ASymbol("else"), APair.fromArray(CONSTANT_CTX, [new ASymbol("quote"), new ASymbol("other")], false)],
              false,
            ),
          ],
          false,
        );
        const result = (await execExprOverFrame(code, { env })) as ASymbol;
        expect(result.__name__).toBe("other");
      });
    });

    describe("when", () => {
      it("should execute body when test is true", async () => {
        // (when #t 1 2 3)
        const code = APair.fromArray(
          CONSTANT_CTX,
          [new ASymbol("when"), schemeTrue, new AExact(1), new AExact(2), new AExact(3)],
          false,
        );
        expect(await execExprOverFrame(code, { env })).toEqual(new AExact(3));
      });

      it("should return undefined when test is false", async () => {
        // (when #f 1 2 3)
        const code = APair.fromArray(
          CONSTANT_CTX,
          [new ASymbol("when"), schemeFalse, new AExact(1), new AExact(2), new AExact(3)],
          false,
        );
        expect(await execExprOverFrame(code, { env })).toBe(theVoid);
      });
    });

    describe("unless", () => {
      it("should execute body when test is false", async () => {
        // (unless #f 1 2 3)
        const code = APair.fromArray(
          CONSTANT_CTX,
          [new ASymbol("unless"), schemeFalse, new AExact(1), new AExact(2), new AExact(3)],
          false,
        );
        expect(await execExprOverFrame(code, { env })).toEqual(new AExact(3));
      });

      it("should return undefined when test is true", async () => {
        // (unless #t 1 2 3)
        const code = APair.fromArray(
          CONSTANT_CTX,
          [new ASymbol("unless"), schemeTrue, new AExact(1), new AExact(2), new AExact(3)],
          false,
        );
        expect(await execExprOverFrame(code, { env })).toBe(theVoid);
      });
    });

    describe("do", () => {
      it("should iterate until test is true", async () => {
        // (do ((i 0 (+ i 1))) ((>= i 5) i))
        const code = APair.fromArray(
          CONSTANT_CTX,
          [
            new ASymbol("do"),
            APair.fromArray(
              CONSTANT_CTX,
              [
                APair.fromArray(
                  CONSTANT_CTX,
                  [
                    new ASymbol("i"),
                    new AExact(0),
                    APair.fromArray(CONSTANT_CTX, [new ASymbol("+"), new ASymbol("i"), new AExact(1)], false),
                  ],
                  false,
                ),
              ],
              false,
            ),
            APair.fromArray(
              CONSTANT_CTX,
              [
                APair.fromArray(CONSTANT_CTX, [new ASymbol(">="), new ASymbol("i"), new AExact(5)], false),
                new ASymbol("i"),
              ],
              false,
            ),
          ],
          false,
        );
        expect(await execExprOverFrame(code, { env })).toEqual(new AExact(5));
      });

      it("should execute body on each iteration", async () => {
        let count = 0;
        env.bind(
          "inc!",
          new ANativeProcedure({
            name: "inc!",
            arity: { min: 0, max: 0 },
            contract: undefined,
            impl: () => {
              count++;
              return theVoid;
            },
          }),
        );
        // (do ((i 0 (+ i 1))) ((>= i 3)) (inc!))
        const code = APair.fromArray(
          CONSTANT_CTX,
          [
            new ASymbol("do"),
            APair.fromArray(
              CONSTANT_CTX,
              [
                APair.fromArray(
                  CONSTANT_CTX,
                  [
                    new ASymbol("i"),
                    new AExact(0),
                    APair.fromArray(CONSTANT_CTX, [new ASymbol("+"), new ASymbol("i"), new AExact(1)], false),
                  ],
                  false,
                ),
              ],
              false,
            ),
            APair.fromArray(
              CONSTANT_CTX,
              [APair.fromArray(CONSTANT_CTX, [new ASymbol(">="), new ASymbol("i"), new AExact(3)], false)],
              false,
            ),
            APair.fromArray(CONSTANT_CTX, [new ASymbol("inc!")], false),
          ],
          false,
        );
        await execExprOverFrame(code, { env });
        expect(count).toBe(3);
      });
    });

    describe("define-macro", () => {
      it("should define a simple macro", async () => {
        // (define-macro (my-when test . body) `(if ,test (begin ,@body)))
        // Then: (my-when #t 1 2 3)
        const defineMacro = APair.fromArray(
          CONSTANT_CTX,
          [
            new ASymbol("define-macro"),
            new APair(new ASymbol("my-when"), new APair(new ASymbol("test"), new ASymbol("body"))),
            APair.fromArray(
              CONSTANT_CTX,
              [
                new ASymbol("quasiquote"),
                APair.fromArray(
                  CONSTANT_CTX,
                  [
                    new ASymbol("if"),
                    APair.fromArray(CONSTANT_CTX, [new ASymbol("unquote"), new ASymbol("test")], false),
                    // (begin ,@body) = (begin (unquote-splicing body))
                    APair.fromArray(
                      CONSTANT_CTX,
                      [
                        new ASymbol("begin"),
                        APair.fromArray(CONSTANT_CTX, [new ASymbol("unquote-splicing"), new ASymbol("body")], false),
                      ],
                      false,
                    ),
                  ],
                  false,
                ),
              ],
              false,
            ),
          ],
          false,
        );
        await execExprOverFrame(defineMacro, { env });

        const code = APair.fromArray(
          CONSTANT_CTX,
          [new ASymbol("my-when"), schemeTrue, new AExact(1), new AExact(2), new AExact(3)],
          false,
        );
        expect(await execExprOverFrame(code, { env })).toEqual(new AExact(3));
      });
    });

    // delay/force — OMITTED by the purity invariant (delayed evaluation defers a
    // value's identity to force-time, severing construction-rooted provenance).
    // Removed from the special-form table; doored in core.ts. The full door
    // surface (delay/force/make-promise/delay-force) is pinned in
    // doors/purity.law.test.ts; here we just confirm the special form is gone.
    describe("delay/force — omitted by the purity invariant", () => {
      it("(delay …) is no longer a working special form", async () => {
        // This raw env has no bootstrap loaded, so `delay` is unbound here (the
        // teaching door — "omitted from arrival by design" — is a bootstrap macro,
        // verified at the full-env layer in doors/purity.law.test.ts). The point at
        // THIS layer: delay no longer evaluates lazily; it is gone from the
        // special-form table.
        await expect(
          execExprOverFrame(
            APair.fromArray(
              CONSTANT_CTX,
              [
                new ASymbol("delay"),
                APair.fromArray(CONSTANT_CTX, [new ASymbol("+"), new AExact(1), new AExact(2)], false),
              ],
              false,
            ),
            { env },
          ),
        ).rejects.toThrow();
      });
    });
  });

  describe("performance - deep recursion", () => {
    it("should handle deep recursion without stack overflow", async () => {
      // Create a deeply nested expression: (+ 1 (+ 1 (+ 1 ... (+ 1 0)...)))
      let code: APair<any, any> | typeof nil = APair.fromArray(
        CONSTANT_CTX,
        [new ASymbol("+"), new AExact(1), new AExact(0)],
        false,
      );

      // 10,000 levels of nesting
      for (let i = 0; i < 10000; i++) {
        code = APair.fromArray(CONSTANT_CTX, [new ASymbol("+"), new AExact(1), code], false);
      }

      const result = await execExprOverFrame(code, { env });
      expect(result).toEqual(new AExact(10001));
    });

    it("should handle deeply nested if expressions", async () => {
      // Create deeply nested ifs: (if #t (if #t (if #t ... 42 ...)))
      let code: SchemeValue = new AExact(42);

      for (let i = 0; i < 10000; i++) {
        code = APair.fromArray(CONSTANT_CTX, [new ASymbol("if"), schemeTrue, code, new AExact(0)], false);
      }

      const result = await execExprOverFrame(code, { env });
      expect(result).toEqual(new AExact(42));
    });

    it("tail recursion to 10k depth does not overflow", async () => {
      // R7RS §3.5: a self-call in tail position must run in O(1) space. This
      // is different from the nested-`+` test above — that nesting lives in a
      // single `run()` generator's stack[]. Here each `(loop (- n 1))` is a
      // FRESH lambda invocation; before TCO (task #46) each one minted a new
      // `run()` Promise the outer trampoline awaited, growing the host call
      // stack one frame per level and overflowing V8 at ~10k ("Maximum call
      // stack size exceeded"). With tail-call collapse + the bounce protocol
      // the loop iterates flat, so 10k completes cleanly.
      const [, result] = await execSource("(define (loop n) (if (= n 0) 'done (loop (- n 1)))) (loop 10000)");
      // `execSource` (generator-exec `exec`, RULINGS.md R1) is the SIMPLE-tier
      // plain-JS exit: a symbol's toJS is apostrophe-prefixed (ASymbol's
      // documented, deferred opaque-exit marker — still design-pending).
      expect(String(result)).toBe("done"); // symbol egress = plain interned name (⚖️ 2026-07-14, constitution §2.1)
    }, 15000);
  });
});

interface ANil {
  toString(): string;
}
