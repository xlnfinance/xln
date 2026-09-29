/**
 * Scheme numeric tower (R7RS-small §6.2: integer ⊂ rational ⊂ real, exact/inexact).
 * - AExact: safe-integer RATIO (`number` num/denom, both always `Number.isSafeInteger`)
 *   — integers AND rationals (denom=1 is the integer case). Out-of-range results THROW
 *   (crash-on-overflow), never silently coerce — see `values/mint-numeric.ts`.
 * - AInexact: IEEE 754 binary64 real, boxed.
 * Tower predicates check VALUES, not types.
 *
 * COMPLEX SUBSETTING (R7RS §6.2.3 permits omitting complex): reals-only, no imaginary
 * axis. sqrt of a negative, make-rectangular/make-polar, "3+4i" literals, and
 * real-part/imag-part/magnitude/angle are DOORED via complexDoor. complex? is an
 * honest stub — always #f; no complex value exists to answer #t.
 */
import invariant from "tiny-invariant";
import { AExact } from "./primitives/AExact.js";
import { AInexact } from "./primitives/AInexact.js";
import { ComplexNumberError } from "../errors.js";

/**
 * Complex tower omitted (R7RS §6.2.3). Door recognizes the omitted feature and
 * explains the real-only alternative. See `ComplexNumberError` (errors.ts).
 */
export function complexDoor(): never {
  throw new ComplexNumberError();
}

export type ANumeric = AExact | AInexact;

/**
 * Integer square root of a non-negative safe-integer `number` (`exact-integer-sqrt`).
 * Under the safe-int invariant `n` never exceeds `Number.MAX_SAFE_INTEGER`, so a float
 * estimate plus correction suffices. `Math.sqrt` can be off by one at the boundary;
 * the two correction loops walk to the true integer sqrt. Returns r with
 * r*r ≤ n < (r+1)*(r+1).
 */
export function exactISqrt(n: number): number {
  invariant(Number.isSafeInteger(n) && n >= 0, "isqrt: requires a non-negative safe integer");
  if (n < 2) return n;
  let r = Math.floor(Math.sqrt(n));
  while (r * r > n) r -= 1;
  while ((r + 1) * (r + 1) <= n) r += 1;
  return r;
}

/**
 * Real value from SchemeNumeric. Lives in the value layer so number classes' own
 * `arrival/tagless-final/lte` can compute without an operators→numbers cycle.
 */
export function toReal(n: ANumeric): number {
  if (n instanceof AExact) {
    return n.valueOf();
  }
  return n.real;
}

/** The exact value of a finite double as `numerator / 2^k` — every finite double is a
 *  dyadic rational, so this is exact (at most 1074 halvings). */
function exactOfDouble(x: number): AExact {
  if (Number.isInteger(x)) return new AExact(BigInt(x));
  let scaled = x;
  let denom = 1n;
  while (!Number.isInteger(scaled)) {
    scaled *= 2;
    denom *= 2n;
  }
  return new AExact(BigInt(scaled), denom);
}

/** An exact number against a double, never through the exact's own (rounded) double:
 *  every exact is finite, so it is below +inf.0 and above -inf.0, and NaN is incomparable. */
function exactVsDouble(x: AExact, d: number): number {
  if (Number.isNaN(d)) return Number.NaN;
  if (d === Number.POSITIVE_INFINITY) return -1;
  if (d === Number.NEGATIVE_INFINITY) return 1;
  return x.cmp(exactOfDouble(d));
}

/**
 * Three-way comparison: -1 / 0 / 1, or NaN if incomparable (either operand NaN).
 * xln fork: exact components are unbounded, so a mixed exact/inexact compare converts the
 * (finite) double to its exact value and compares exactly — a float compare would round a
 * big exact and break transitivity (`(= 9007199254740992.0 9007199254740993)` must be #f).
 */
export function schemeCompare(a: ANumeric, b: ANumeric): number {
  if (a instanceof AExact && b instanceof AExact) {
    return a.cmp(b);
  }
  if (a instanceof AExact) return exactVsDouble(a, toReal(b));
  if (b instanceof AExact) return -exactVsDouble(b, toReal(a));
  const ar = toReal(a);
  const br = toReal(b);
  if (Number.isNaN(ar) || Number.isNaN(br)) return Number.NaN;
  if (ar < br) return -1;
  if (ar > br) return 1;
  return 0;
}

/** Parse magnitude via BigInt — exact at any size (xln fork: exact components are unbounded). */
function parseSafeIntLiteral(magnitude: bigint, _original: string): bigint {
  return magnitude;
}

// Host-facing string→number utility (re-exported off `index.ts`). Mints under CONSTANT_CTX;
// a live rosetta/MCP caller should pass the crossing's own ctx rather than this default.
export function parseNumber(str: string): ANumeric {
  str = str.trim();

  let forceExact = false;
  let forceInexact = false;

  if (str.startsWith("#e") || str.startsWith("#E")) {
    forceExact = true;
    str = str.slice(2);
  } else if (str.startsWith("#i") || str.startsWith("#I")) {
    forceInexact = true;
    str = str.slice(2);
  }

  let radix = 10;
  if (str.startsWith("#b") || str.startsWith("#B")) {
    radix = 2;
    str = str.slice(2);
  } else if (str.startsWith("#o") || str.startsWith("#O")) {
    radix = 8;
    str = str.slice(2);
  } else if (str.startsWith("#d") || str.startsWith("#D")) {
    radix = 10;
    str = str.slice(2);
  } else if (str.startsWith("#x") || str.startsWith("#X")) {
    radix = 16;
    str = str.slice(2);
  }

  if (str === "+inf.0") return new AInexact(Infinity);
  if (str === "-inf.0") return new AInexact(-Infinity);
  if (str === "+nan.0" || str === "-nan.0") return new AInexact(Number.NaN);

  const complexMatch = str.match(/^([+-]?[\d.]+)?([+-][\d.]*)?i$/);
  if (complexMatch) {
    const imag = complexMatch[2] === undefined ? 1 : Number.parseFloat(complexMatch[2] || "+1");
    if (imag === 0) {
      const real = complexMatch[1] ? Number.parseFloat(complexMatch[1]) : 0;
      return new AInexact(real);
    }
    return complexDoor();
  }

  const rationalMatch = str.match(/^([+-]?\d+)\/(\d+)$/);
  if (rationalMatch) {
    const num = parseSafeIntLiteral(BigInt(rationalMatch[1]), str);
    const denom = parseSafeIntLiteral(BigInt(rationalMatch[2]), str);
    const result = new AExact(num, denom);
    if (forceInexact) {
      return result.toInexact();
    }
    return result;
  }

  if (str.includes(".") || str.includes("e") || str.includes("E")) {
    const value = Number.parseFloat(str);
    if (forceExact) {
      return new AInexact(value).toExact();
    }
    return new AInexact(value);
  }

  // Integer: BigInt so digits beyond 2^53 are exact; parseSafeIntLiteral throws if over range.
  const neg = str.startsWith("-");
  const digits = neg || str.startsWith("+") ? str.slice(1) : str;
  const prefix = radix === 16 ? "0x" : radix === 8 ? "0o" : radix === 2 ? "0b" : "";
  const magnitudeBig = BigInt(prefix + digits);
  const exactNum = parseSafeIntLiteral(neg ? -magnitudeBig : magnitudeBig, str);
  const exact = new AExact(exactNum);
  if (forceInexact) {
    return exact.toInexact();
  }
  return exact;
}

/** Honest stub — complex tower omitted (R7RS §6.2.3). Always #f. */
export function isComplex(_n: unknown): boolean {
  return false;
}

export function isInteger(n: unknown): n is AExact | number {
  if (n instanceof AExact) {
    return n.isInteger;
  }
  if (n instanceof AInexact) {
    return false;
  }
  // Host bigint is not a scheme number (membrane NoLensError).
  if (typeof n === "number") {
    return Number.isInteger(n);
  }
  return false;
}

// INTEROP BOUNDARY: AExact/AInexact carry the tower surface on their prototypes.
// The nominal FAMILY RULE in interop-access.ts (`instanceof AValue`) restricts
// interop member-access to own properties (num/denom / real) — blocking tower methods.
// Arithmetic ops scheme uses (`+`, `*`, `floor`, …) live in env bindings, not on these prototypes.
