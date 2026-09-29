// AExact — exact number (integers and rationals) over UNBOUNDED `bigint` components.
//
// xln fork: the upstream one-number rework (dde9efb2) held num/denom to safe-integer
// `number`s and threw on overflow. A money spec needs uint256 arithmetic, so the
// components are `bigint` here and exact `+ − × /` never overflow. `num`/`denom` stay
// as `number` getters for the call sites that genuinely need a machine number (char
// codes, list indices, string radix): they read back exactly in the safe range and
// throw ExactOverflowError outside it — the old door, now only at those edges.
//
// AExact↔numbers.ts and AExact↔AInexact edges are benign runtime cycles (method-body only).
import invariant from "tiny-invariant";
import { AValue, EMPTY_PROVENANCE } from "./AValue.js";
import { isComplex, schemeCompare } from "../numbers.js";
import { AInexact } from "./AInexact.js";
import type { SourceLocation } from "../../errors.js";
import { ExactOverflowError, mintExact } from "../mint-numeric.js";

/** A component as `bigint`: a `number` must already be a safe integer (an unsafe one is an
 *  arrival bug upstream of here, not a program event). */
function big(x: number | bigint, what: string): bigint {
  if (typeof x === "bigint") return x;
  invariant(Number.isSafeInteger(x), `AExact: ${what} ${x} is not a safe integer`);
  return BigInt(x);
}

function bigAbs(x: bigint): bigint {
  return x < 0n ? -x : x;
}

function bigGcd(a: bigint, b: bigint): bigint {
  a = bigAbs(a);
  b = bigAbs(b);
  while (b !== 0n) {
    const t = b;
    b = a % b;
    a = t;
  }
  return a;
}

const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);

/** Read a component as a machine `number` — exact in the safe range, a door outside it. */
function machine(x: bigint, op: string): number {
  if (x > MAX_SAFE || x < -MAX_SAFE) throw new ExactOverflowError(op, x.toString());
  return Number(x);
}

export class AExact extends AValue {
  readonly kind = "number" as const;

  /** Numerator, gcd-normalized; carries the sign. */
  readonly numerator: bigint;
  /** Denominator, gcd-normalized; always positive. */
  readonly denominator: bigint;

  constructor(
    num: number | bigint,
    denom: number | bigint = 1,
    provenance: ReadonlySet<number> = EMPTY_PROVENANCE,
    location?: SourceLocation,
  ) {
    super(provenance, location);
    let n = big(num, "num");
    let d = big(denom, "denom");
    invariant(d !== 0n, "Division by zero");
    if (d < 0n) {
      n = -n;
      d = -d;
    }
    const g = bigGcd(n, d);
    this.numerator = g === 0n ? n : n / g;
    this.denominator = g === 0n ? d : d / g;
  }

  /** Numerator as a machine number; throws ExactOverflowError outside the safe range. */
  get num(): number {
    return machine(this.numerator, "machine-number read");
  }

  /** Denominator as a machine number; throws ExactOverflowError outside the safe range. */
  get denom(): number {
    return machine(this.denominator, "machine-number read");
  }

  get isInteger(): boolean {
    return this.denominator === 1n;
  }

  get isRational(): boolean {
    return true; // all exact numbers are rational
  }

  get isReal(): boolean {
    return true;
  }

  get isComplex(): boolean {
    return isComplex(this);
  }

  get isExact(): boolean {
    return true;
  }

  get isZero(): boolean {
    return this.numerator === 0n;
  }

  get isPositive(): boolean {
    return this.numerator > 0n;
  }

  get isNegative(): boolean {
    return this.numerator < 0n;
  }

  get isNaN(): boolean {
    return false;
  }

  get isFinite(): boolean {
    return true;
  }

  /** The nearest double; exact in the safe range, rounded beyond it. */
  valueOf(): number {
    return this.denominator === 1n ? Number(this.numerator) : Number(this.numerator) / Number(this.denominator);
  }

  /** Egress: a safe integer leaves as `number`, a larger integer as `bigint`, a rational
   *  as its nearest double (`toJS(1/3)` = `0.333…`). */
  ["arrival/toJS"](): number | bigint {
    if (this.denominator === 1n) {
      return this.numerator > MAX_SAFE || this.numerator < -MAX_SAFE ? this.numerator : Number(this.numerator);
    }
    return this.valueOf();
  }

  withProvenance(p: ReadonlySet<number>): AExact {
    return new AExact(this.numerator, this.denominator, p, this.location);
  }

  toString(): string {
    if (this.denominator === 1n) {
      return this.numerator.toString();
    }
    return `${this.numerator}/${this.denominator}`;
  }

  ["arrival/print"](): string {
    return this.toString();
  }

  cmp(other: AExact): -1 | 0 | 1 {
    const diff = this.numerator * other.denominator - other.numerator * this.denominator;
    if (diff < 0n) return -1;
    if (diff > 0n) return 1;
    return 0;
  }

  equals(other: AExact): boolean {
    return this.numerator === other.numerator && this.denominator === other.denominator;
  }

  // Setoid — exact ≡ exact ONLY, never equal to inexact (R7RS eqv?).
  // structuralEqual/equal? consults this BEFORE the valueOf fast path, so `(equal? 1 1.0)` is #f.
  ["arrival/tagless-final/equals"](other: unknown): boolean {
    return other instanceof AExact && this.equals(other);
  }

  // Ord — numeric via schemeCompare: `(<= 1 1.0)` is #t (cross-type), unlike Setoid.
  // NaN ⇒ schemeCompare returns NaN ⇒ every derived relation collapses to #f.
  ["arrival/tagless-final/lte"](other: unknown): boolean {
    return (other instanceof AExact || other instanceof AInexact) && schemeCompare(this, other) <= 0;
  }

  add(other: AExact): AExact {
    return mintExact(
      this.numerator * other.denominator + other.numerator * this.denominator,
      this.denominator * other.denominator,
    );
  }

  sub(other: AExact): AExact {
    return mintExact(
      this.numerator * other.denominator - other.numerator * this.denominator,
      this.denominator * other.denominator,
    );
  }

  mul(other: AExact): AExact {
    return mintExact(this.numerator * other.numerator, this.denominator * other.denominator);
  }

  div(other: AExact): AExact {
    // R7RS: exact `(/ x 0)` errors (the constructor's "Division by zero" invariant); only
    // `0.0` division is IEEE `inf`/`nan`.
    return mintExact(this.numerator * other.denominator, this.denominator * other.numerator);
  }

  neg(): AExact {
    return mintExact(-this.numerator, this.denominator);
  }

  abs(): AExact {
    return mintExact(bigAbs(this.numerator), this.denominator);
  }

  inverse(): AExact {
    return mintExact(this.denominator, this.numerator);
  }

  // Floor/ceiling/truncate/round return exact integers. bigint `/` truncates toward zero.
  floor(): AExact {
    if (this.isInteger) return this;
    const q = this.numerator / this.denominator;
    return mintExact(this.numerator < 0n ? q - 1n : q, 1n);
  }

  ceiling(): AExact {
    if (this.isInteger) return this;
    const q = this.numerator / this.denominator;
    return mintExact(this.numerator > 0n ? q + 1n : q, 1n);
  }

  truncate(): AExact {
    if (this.isInteger) return this;
    return mintExact(this.numerator / this.denominator, 1n);
  }

  round(): AExact {
    if (this.isInteger) return this;
    // Round to nearest, ties to even.
    const q = this.numerator / this.denominator;
    const r = this.numerator % this.denominator;
    const twice = 2n * bigAbs(r);
    const away = this.numerator < 0n ? q - 1n : q + 1n;
    if (twice < this.denominator) return mintExact(q, 1n);
    if (twice > this.denominator) return mintExact(away, 1n);
    return mintExact(q % 2n === 0n ? q : away, 1n);
  }

  mod(other: AExact): AExact {
    invariant(this.isInteger && other.isInteger, "mod requires integers");
    return mintExact(this.numerator % other.numerator, 1n);
  }

  quotient(other: AExact): AExact {
    invariant(this.isInteger && other.isInteger, "quotient requires integers");
    return mintExact(this.numerator / other.numerator, 1n);
  }

  gcd(other: AExact): AExact {
    invariant(this.isInteger && other.isInteger, "gcd requires integers");
    return mintExact(bigGcd(this.numerator, other.numerator), 1n);
  }

  toInexact(): AInexact {
    return new AInexact(this.valueOf());
  }
}
