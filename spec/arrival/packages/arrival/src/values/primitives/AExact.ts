// AExact — exact number (integers and rationals) over SAFE-INTEGER `number` components.
//
// SAFE-INTEGER EXACT: `num`/`denom` are plain JS `number`s, each always
// `Number.isSafeInteger` — never `bigint`. Given safe operands, IEEE double
// arithmetic on integers is exact whenever the true result is in safe range, and
// a true result ≥ 2^53 can never round back INTO safe range — so a post-op
// `Number.isSafeInteger` check is a sound exactness gate for the closed `+ − ×`
// algebra. A result whose num or denom would leave safe range THROWS
// (`ExactOverflowError` via `../mint-numeric.js`) — never silently coerces to inexact.
//
// AExact↔numbers.ts and AExact↔AInexact edges are benign runtime cycles (method-body only).
import invariant from "tiny-invariant";
import { AValue, EMPTY_PROVENANCE } from "./AValue.js";
import { isComplex, schemeCompare } from "../numbers.js";
import { AInexact } from "./AInexact.js";
import type { SourceLocation } from "../../errors.js";
import {
  checkedAdd,
  checkedMul,
  checkedSub,
  debugCrossCheckRational,
  isNumericDebugEnabled,
  mintExact,
} from "../mint-numeric.js";

export class AExact extends AValue {
  readonly kind = "number" as const;

  readonly num: number;
  readonly denom: number;

  constructor(
    num: number,
    denom: number = 1,
    provenance: ReadonlySet<number> = EMPTY_PROVENANCE,
    location?: SourceLocation,
  ) {
    super(provenance, location);
    invariant(denom !== 0, "Division by zero");
    // Internal invariant, NOT the overflow door: callers must pre-check via
    // checkedMul/checkedAdd/checkedSub or mintExact. Unsafe components here are an
    // arrival bug (gate leak), not a program-level event — plain invariant, never ExactOverflowError.
    invariant(
      Number.isSafeInteger(num),
      `AExact: num ${num} is not a safe integer — the caller must check via checkedMul/checkedAdd/checkedSub (or mintExact) before constructing`,
    );
    invariant(
      Number.isSafeInteger(denom),
      `AExact: denom ${denom} is not a safe integer — the caller must check via checkedMul/checkedAdd/checkedSub (or mintExact) before constructing`,
    );
    if (denom < 0) {
      num = -num;
      denom = -denom;
    }
    const g = AExact.gcd(num, denom);
    const normNum = num / g;
    // Exact -0 is unconstructible — normalize the -0 that `0 / g` can produce.
    this.num = normNum === 0 ? 0 : normNum;
    this.denom = denom / g;
  }

  get isInteger(): boolean {
    return this.denom === 1;
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
    return this.num === 0;
  }

  get isPositive(): boolean {
    return this.num > 0;
  }

  get isNegative(): boolean {
    return this.num < 0;
  }

  get isNaN(): boolean {
    return false;
  }

  get isFinite(): boolean {
    return true;
  }

  /** Euclid over safe-int `number`s. `%` never grows magnitude past its larger operand. */
  private static gcd(a: number, b: number): number {
    a = a < 0 ? -a : a;
    b = b < 0 ? -b : b;
    while (b !== 0) {
      const t = b;
      b = a % b;
      a = t;
    }
    return a;
  }

  valueOf(): number {
    return this.num / this.denom;
  }

  /** Egress divides: integer arm is bare return; rational arm's float division is intentional
   *  (`toJS(1/3)` = `0.333…`). */
  ["arrival/toJS"](): number {
    if (this.denom === 1) {
      return this.num;
    }
    return this.valueOf();
  }

  withProvenance(p: ReadonlySet<number>): AExact {
    return new AExact(this.num, this.denom, p, this.location);
  }

  toString(): string {
    if (this.denom === 1) {
      return this.num.toString();
    }
    return `${this.num}/${this.denom}`;
  }

  ["arrival/print"](): string {
    return this.toString();
  }

  // Same-type comparison. Cross-multiplies for exactness, but a comparison never
  // crashes on overflow: if the intermediate would leave safe range, falls back to
  // float (`valueOf()`) compare — a comparator only needs ORDER, never a reconstructed value.
  cmp(other: AExact): -1 | 0 | 1 {
    const left = this.num * other.denom;
    const right = other.num * this.denom;
    if (Number.isSafeInteger(left) && Number.isSafeInteger(right)) {
      const diff = left - right;
      if (Number.isSafeInteger(diff)) {
        if (diff < 0) return -1;
        if (diff > 0) return 1;
        return 0;
      }
    }
    const lv = this.valueOf();
    const rv = other.valueOf();
    if (lv < rv) return -1;
    if (lv > rv) return 1;
    return 0;
  }

  equals(other: AExact): boolean {
    return this.num === other.num && this.denom === other.denom;
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

  // Same-type arithmetic. Each cross-multiplied intermediate is checked BEFORE the
  // gcd-normalizing constructor — mintExact's re-check is defense in depth (a float
  // product that already overflowed can round back to something that LOOKS safe).
  // DEBUG belt (ARRIVAL_NUMERIC_DEBUG) cross-checks against BigInt when set.
  add(other: AExact): AExact {
    const num = checkedAdd(
      checkedMul(this.num, other.denom, "exact +"),
      checkedMul(other.num, this.denom, "exact +"),
      "exact +",
    );
    const denom = checkedMul(this.denom, other.denom, "exact +");
    const result = mintExact(num, denom, undefined, "exact +");
    if (isNumericDebugEnabled()) {
      debugCrossCheckRational("add", this.num, this.denom, other.num, other.denom, result.num, result.denom);
    }
    return result;
  }

  sub(other: AExact): AExact {
    const num = checkedSub(
      checkedMul(this.num, other.denom, "exact -"),
      checkedMul(other.num, this.denom, "exact -"),
      "exact -",
    );
    const denom = checkedMul(this.denom, other.denom, "exact -");
    const result = mintExact(num, denom, undefined, "exact -");
    if (isNumericDebugEnabled()) {
      debugCrossCheckRational("sub", this.num, this.denom, other.num, other.denom, result.num, result.denom);
    }
    return result;
  }

  mul(other: AExact): AExact {
    const num = checkedMul(this.num, other.num, "exact *");
    const denom = checkedMul(this.denom, other.denom, "exact *");
    const result = mintExact(num, denom, undefined, "exact *");
    if (isNumericDebugEnabled()) {
      debugCrossCheckRational("mul", this.num, this.denom, other.num, other.denom, result.num, result.denom);
    }
    return result;
  }

  div(other: AExact): AExact {
    const num = checkedMul(this.num, other.denom, "exact /");
    const denom = checkedMul(this.denom, other.num, "exact /");
    // Zero-denominator still throws via AExact's "Division by zero" invariant inside mintExact.
    // R7RS: exact `(/ x 0)` errors; only `0.0` division is IEEE `inf`/`nan`.
    const result = mintExact(num, denom, undefined, "exact /");
    if (isNumericDebugEnabled()) {
      debugCrossCheckRational("div", this.num, this.denom, other.num, other.denom, result.num, result.denom);
    }
    return result;
  }

  neg(): AExact {
    return mintExact(-this.num, this.denom, undefined, "exact negate");
  }

  abs(): AExact {
    return mintExact(this.num < 0 ? -this.num : this.num, this.denom, undefined, "exact abs");
  }

  inverse(): AExact {
    return mintExact(this.denom, this.num, undefined, "exact inverse");
  }

  // Floor/ceiling/truncate/round return exact integers. Quotient via `%` then
  // exact subtraction-then-division so the result is the TRUE truncated integer.
  floor(): AExact {
    if (this.denom === 1) return this;
    const r = this.num % this.denom;
    const q = (this.num - r) / this.denom;
    if (this.num < 0 && r !== 0) {
      return mintExact(q - 1, 1, undefined, "exact floor");
    }
    return mintExact(q, 1, undefined, "exact floor");
  }

  ceiling(): AExact {
    if (this.denom === 1) return this;
    const r = this.num % this.denom;
    const q = (this.num - r) / this.denom;
    if (this.num > 0 && r !== 0) {
      return mintExact(q + 1, 1, undefined, "exact ceiling");
    }
    return mintExact(q, 1, undefined, "exact ceiling");
  }

  truncate(): AExact {
    if (this.denom === 1) return this;
    const r = this.num % this.denom;
    const q = (this.num - r) / this.denom;
    return mintExact(q, 1, undefined, "exact truncate");
  }

  round(): AExact {
    if (this.denom === 1) return this;
    // Round to nearest, ties to even
    const r = this.num % this.denom;
    const q = (this.num - r) / this.denom;
    const absR = r < 0 ? -r : r;
    // Dividing a safe-int by 2 is always exact in a double (exponent shift).
    const halfDenom = Math.trunc(this.denom / 2);

    if (absR < halfDenom) {
      return mintExact(q, 1, undefined, "exact round");
    } else if (absR > halfDenom) {
      return mintExact(this.num < 0 ? q - 1 : q + 1, 1, undefined, "exact round");
    } else {
      if (q % 2 === 0) {
        return mintExact(q, 1, undefined, "exact round");
      }
      return mintExact(this.num < 0 ? q - 1 : q + 1, 1, undefined, "exact round");
    }
  }

  mod(other: AExact): AExact {
    invariant(this.isInteger && other.isInteger, "mod requires integers");
    return mintExact(this.num % other.num, 1, undefined, "exact modulo");
  }

  quotient(other: AExact): AExact {
    invariant(this.isInteger && other.isInteger, "quotient requires integers");
    const r = this.num % other.num;
    const q = (this.num - r) / other.num;
    return mintExact(q, 1, undefined, "quotient");
  }

  gcd(other: AExact): AExact {
    invariant(this.isInteger && other.isInteger, "gcd requires integers");
    return mintExact(AExact.gcd(this.num, other.num), 1, undefined, "gcd");
  }

  toInexact(): AInexact {
    return new AInexact(this.valueOf());
  }
}
