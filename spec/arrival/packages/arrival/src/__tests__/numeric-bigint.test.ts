// xln fork: exact integers are unbounded (bigint components). A money spec needs uint256.
import { describe, expect, it } from "vitest";
import { exec } from "../index.js";

const last = async (src: string) => (await exec(src)).at(-1);
const U256_MAX = 2n ** 256n - 1n;

describe("unbounded exact integers", () => {
  it("adds past 2^53 exactly", async () => {
    expect(await last(`(+ 9007199254740991 1)`)).toBe(9007199254740992n);
  });

  it("reads a literal of any size exactly", async () => {
    expect(await last(`(* 1000000000000000000 1000)`)).toBe(10n ** 21n);
  });

  it("computes 2^256 - 1 and prints it", async () => {
    expect(await last(`(- (expt 2 256) 1)`)).toBe(U256_MAX);
    expect(await last(`(number->string (- (expt 2 256) 1))`)).toBe(U256_MAX.toString());
  });

  it("divides and takes remainders on big integers", async () => {
    expect(await last(`(quotient (expt 10 30) 7)`)).toBe(10n ** 30n / 7n);
    expect(await last(`(remainder (expt 10 30) 7)`)).toBe(Number(10n ** 30n % 7n));
    expect(await last(`(floor-quotient (- (expt 10 30)) 7)`)).toBe(-(10n ** 30n / 7n) - 1n);
    expect(await last(`(modulo (- (expt 10 30)) 7)`)).toBe(Number(((-(10n ** 30n) % 7n) + 7n) % 7n));
  });

  it("keeps exact rationals over big components", async () => {
    expect(await last(`(* (/ (expt 10 30) 3) 3)`)).toBe(10n ** 30n);
    expect(await last(`(= (/ (expt 2 100) (expt 2 99)) 2)`)).toBe(true);
  });

  it("compares and tests equality exactly beyond 2^53", async () => {
    expect(await last(`(< (expt 2 200) (+ (expt 2 200) 1))`)).toBe(true);
    expect(await last(`(equal? (expt 2 200) (* (expt 2 100) (expt 2 100)))`)).toBe(true);
    expect(await last(`(= (+ (expt 2 60) 1) (expt 2 60))`)).toBe(false);
  });

  it("takes exact integer square roots of big squares", async () => {
    expect(await last(`(sqrt (expt 3 200))`)).toBe(3n ** 100n);
    expect(await last(`(gcd (expt 2 100) (expt 6 50))`)).toBe(2 ** 50);
  });

  it("returns a safe integer as a number, a big one as a bigint", async () => {
    expect(await last(`(+ 1 2)`)).toBe(3);
    expect(typeof (await last(`(expt 2 64)`))).toBe("bigint");
  });

  it("accepts a host bigint as an exact integer", async () => {
    const { execState, toJS, LexicalScope } = await import("../index.js");
    const scope = LexicalScope.fresh("big");
    await execState(`(define (double x) (* 2 x))`, { scope });
    const { values } = await execState(`double`, { scope });
    const double = toJS(values.at(-1)!) as (x: bigint) => Promise<unknown>;
    expect(await double(2n ** 255n)).toBe(2n ** 256n);
  });
});
