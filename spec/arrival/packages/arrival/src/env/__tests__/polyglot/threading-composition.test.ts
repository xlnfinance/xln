/**
 * Polyglot threading and composition — behavior over the DEFAULT assembled env
 * (freshEnv(), full BASE_PACKS), so it stays true across the dialect split (V,
 * 2026-07-10): `->`/`->>`/`comp` now live in env/polyglot/polyglot-clojure.ts, `~>`/`~>>`
 * in env/polyglot/polyglot-racket.ts, `compose`/`pipe`/`flow` in the shared core
 * (env/polyglot/polyglot.ts) — see polyglot.ts's header for the full sibling-pack map.
 *
 * arrival-scheme accepts the whole cross-dialect family so writers (LLMs
 * included) can use whatever muscle-memory they have, exactly like :key
 * accessors:
 *   ->  / ~>    thread the value as the FIRST argument  (Clojure / Racket)
 *   ->> / ~>>   thread the value as the LAST  argument  (Clojure / Racket)
 *   compose / comp   right-to-left function composition
 *   pipe / flow      left-to-right function composition
 *
 * Non-commutative ops ((- …)) prove the first/last insertion direction;
 * compose-vs-pipe is proven by an order-sensitive lambda pair.
 */
import { describe, expect, it } from "vitest";
import { execOverFrame as exec } from "../../../eval/generator-exec.js";
import { freshEnv } from "../../../__tests__/_fresh-env.js";

const env = await freshEnv();

const num = (r: unknown): number => {
  if (typeof r === "number") return r;
  if (typeof r === "bigint") return Number(r);
  if (r && typeof (r as { valueOf?: unknown }).valueOf === "function") {
    return Number((r as { valueOf: () => unknown }).valueOf());
  }
  return Number.NaN;
};
const val = async (src: string): Promise<unknown> => (await exec(src, { env }))[0];

describe("threading macros — first vs last insertion", () => {
  it.each([
    { name: "->-inserts-first-single-step", src: `(-> 10 (- 3))`, expected: 7 }, //   (- 10 3)
    { name: "->-inserts-first-multi-step", src: `(-> 1 (+ 2) (* 10))`, expected: 30 }, // (* (+ 1 2) 10)
    { name: "->>-inserts-last-single-step", src: `(->> 10 (- 3))`, expected: -7 }, //  (- 3 10)
    { name: "->>-inserts-last-multi-step", src: `(->> 1 (- 10) (* 2))`, expected: 18 }, // (* 2 (- 10 1))
    { name: "~>-aliases-->", src: `(~> 10 (- 3))`, expected: 7 },
    { name: "~>>-aliases-->>", src: `(~>> 10 (- 3))`, expected: -7 },
    { name: "bare-symbol-threads-as-unary-call-car", src: `(-> (list 1 2 3) car)`, expected: 1 },
    { name: "bare-symbol-threads-as-unary-call-reverse-car", src: `(->> (list 1 2 3) reverse car)`, expected: 3 },
  ])("$name", async ({ src, expected }) => {
    expect(num(await val(src))).toBe(expected);
  });
});

describe("composition combinators — direction + aliases", () => {
  it.each([
    // (+1) then (*2) reading right-to-left for compose, left-to-right for pipe
    { name: "compose-is-right-to-left", src: `((compose (lambda (x) (* x 2)) (lambda (x) (+ x 1))) 5)`, expected: 12 },
    { name: "pipe-is-left-to-right", src: `((pipe (lambda (x) (* x 2)) (lambda (x) (+ x 1))) 5)`, expected: 11 },
    { name: "comp-aliases-compose", src: `((comp car cdr) (list 1 2 3))`, expected: 2 }, // car(cdr(xs))
    { name: "flow-aliases-pipe", src: `((flow cdr car) (list 1 2 3))`, expected: 2 }, // car(cdr(xs))
    { name: "pipe-first-function-may-be-n-ary", src: `((pipe + (lambda (x) (* x 10))) 2 3)`, expected: 50 }, // (* (+ 2 3) 10)
    { name: "compose-first-function-may-be-n-ary", src: `((compose (lambda (x) (* x 10)) +) 2 3)`, expected: 50 },
  ])("$name", async ({ src, expected }) => {
    expect(num(await val(src))).toBe(expected);
  });
});
