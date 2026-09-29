// AInexact — floating-point inexact number (reals only; complex axis omitted, see numbers.ts).
// Safe-integer exact contract: float→exact conversion gates through mintExact (overflow throws).
// AInexact↔AExact and AInexact↔numbers.ts edges are benign runtime cycles (method-body only).
import invariant from "tiny-invariant";
import { AValue, EMPTY_PROVENANCE } from "./AValue.js";
import { complexDoor, isComplex, schemeCompare } from "../numbers.js";
import { AExact } from "./AExact.js";
import { mintExact } from "../mint-numeric.js";
import type { SourceLocation } from "../../errors.js";

export class AInexact extends AValue {
  readonly kind = "number" as const;

  readonly real: number;

  constructor(real: number, provenance: ReadonlySet<number> = EMPTY_PROVENANCE, location?: SourceLocation) {
    super(provenance, location);
    this.real = real;
  }

  get isInteger(): boolean {
    return Number.isInteger(this.real);
  }

  get isRational(): boolean {
    // R7RS: all finite reals are rational (IEEE floats are dyadic fractions).
    return Number.isFinite(this.real);
  }

  // Reals-only tower: every inexact value IS real.
  get isReal(): boolean {
    return true;
  }

  get isComplex(): boolean {
    return isComplex(this);
  }

  get isExact(): boolean {
    return false;
  }

  get isZero(): boolean {
    return this.real === 0;
  }

  get isPositive(): boolean {
    return this.real > 0;
  }

  get isNegative(): boolean {
    return this.real < 0;
  }

  get isNaN(): boolean {
    return Number.isNaN(this.real);
  }

  get isFinite(): boolean {
    return Number.isFinite(this.real);
  }

  private static floatToRational(x: number, _tolerance: number = 1e-10): AExact {
    if (Number.isInteger(x)) {
      return mintExact(x, 1, undefined, "inexact->exact");
    }

    // Decimal representation via mintExact so a wide expansion that leaves safe-integer
    // range THROWS rather than silently truncating.
    const str = x.toString();
    const dotIndex = str.indexOf(".");
    if (dotIndex === -1) {
      return mintExact(x, 1, undefined, "inexact->exact");
    }

    const decimals = str.length - dotIndex - 1;
    const denom = 10 ** decimals;
    const num = Number(str.replace(".", ""));
    return mintExact(num, denom, undefined, "inexact->exact");
  }

  valueOf(): number {
    return this.real;
  }

  /** Mirrors the `toJS` rosetta path (reals-only). */
  ["arrival/toJS"](): number {
    return this.real;
  }

  withProvenance(p: ReadonlySet<number>): AInexact {
    return new AInexact(this.real, p, this.location);
  }

  // Scheme inexact form with decimal point; chibi-compatible markers for non-finites.
  toString(): string {
    if (Number.isInteger(this.real)) {
      return `${this.real}.0`;
    }
    if (Number.isNaN(this.real)) return "+nan.0";
    if (this.real === Infinity) return "+inf.0";
    if (this.real === -Infinity) return "-inf.0";
    return this.real.toString();
  }

  ["arrival/print"](): string {
    return this.toString();
  }

  // R7RS §6.2.6 — every numeric comparison against +nan.0 is #f. Return NaN when
  // either operand is NaN so `=== 0` / `< 0` / `> 0` all correctly fail.
  cmp(other: AInexact): -1 | 0 | 1 | number {
    if (this.real < other.real) return -1;
    if (this.real > other.real) return 1;
    if (this.real === other.real) return 0;
    return Number.NaN;
  }

  equals(other: AInexact): boolean {
    return this.real === other.real;
  }

  // Setoid — inexact ≡ inexact ONLY. Object.is so reflexivity holds for NaN
  // (`(eqv? +nan.0 +nan.0)` ⇒ #t) and ±0 stay distinct.
  ["arrival/tagless-final/equals"](other: unknown): boolean {
    return other instanceof AInexact && Object.is(this.real, other.real);
  }

  // Ord — numeric value via schemeCompare (cross-type; NaN ⇒ #f). Distinct from Setoid's Object.is.
  ["arrival/tagless-final/lte"](other: unknown): boolean {
    return (other instanceof AExact || other instanceof AInexact) && schemeCompare(this, other) <= 0;
  }

  add(other: AInexact): AInexact {
    return new AInexact(this.real + other.real);
  }

  sub(other: AInexact): AInexact {
    return new AInexact(this.real - other.real);
  }

  mul(other: AInexact): AInexact {
    return new AInexact(this.real * other.real);
  }

  div(other: AInexact): AInexact {
    // IEEE division: 1.0/0.0 = +inf.0, 0.0/0.0 = +nan.0.
    return new AInexact(this.real / other.real);
  }

  neg(): AInexact {
    return new AInexact(-this.real);
  }

  abs(): AInexact {
    return new AInexact(Math.abs(this.real));
  }

  floor(): AInexact {
    return new AInexact(Math.floor(this.real));
  }

  ceiling(): AInexact {
    return new AInexact(Math.ceil(this.real));
  }

  truncate(): AInexact {
    return new AInexact(Math.trunc(this.real));
  }

  round(): AInexact {
    // Scheme: ties to even
    const floored = Math.floor(this.real);
    const diff = this.real - floored;
    if (diff < 0.5) return new AInexact(floored);
    if (diff > 0.5) return new AInexact(floored + 1);
    if (floored % 2 === 0) return new AInexact(floored);
    return new AInexact(floored + 1);
  }

  // Transcendentals. sqrt of a negative DOORS — complex not representable (complexDoor).
  sqrt(): AInexact {
    if (this.real < 0) complexDoor();
    return new AInexact(Math.sqrt(this.real));
  }

  exp(): AInexact {
    return new AInexact(Math.exp(this.real));
  }

  log(): AInexact {
    return new AInexact(Math.log(this.real));
  }

  sin(): AInexact {
    return new AInexact(Math.sin(this.real));
  }

  cos(): AInexact {
    return new AInexact(Math.cos(this.real));
  }

  tan(): AInexact {
    return new AInexact(Math.tan(this.real));
  }

  pow(exponent: AInexact): AInexact {
    if (this.isZero) {
      // R7RS §6.2.6: 0^0 = 1; 0^positive = 0; 0^negative is undefined.
      if (exponent.isZero) return new AInexact(1);
      invariant(exponent.real > 0, "expt: 0 raised to a negative power (division by zero)");
      return new AInexact(0);
    }
    return new AInexact(Math.pow(this.real, exponent.real));
  }

  toExact(): AExact {
    invariant(Number.isFinite(this.real), "Infinite number cannot be converted to exact");
    invariant(!Number.isNaN(this.real), "NaN cannot be converted to exact");
    return AInexact.floatToRational(this.real);
  }
}
