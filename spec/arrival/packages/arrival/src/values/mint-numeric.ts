// mint-numeric.ts — the ONE choke point for minting a checked `AExact` under the
// safe-operand invariant (docs/design-history/arrival-one-number-rework.md §0.2/§0.3,
// §2.1: "RATIO with crash-on-overflow"). Every exact-producing op should route its final
// num/denom (or a bare integral result) through `mintExact` rather than
// calling `new AExact(...)` directly, so the crash-on-overflow law and the DEBUG
// bigint-cross-check live in one place instead of being re-derived per call site.
//
// AExact.ts's own arithmetic methods (add/sub/mul/div) are the one place that must go
// FURTHER than the final mint: they pre-check every cross-multiplied INTERMEDIATE
// (`a*d`, `b*c`, `ad+bc`, `b*d`) via `checkedMul`/`checkedAdd`/`checkedSub` before the
// gcd-normalizing constructor ever runs, because a silently-overflowed float product can
// round to a value that LOOKS like a safe integer after the fact — the invariant (§0.2)
// is sound only when EVERY operand feeding an intermediate was itself checked. Those
// three helpers live here so any op file shares one overflow law instead of
// reinventing it per cluster.
//
// Benign runtime cycle with AExact.ts (same shape as the AExact↔AInexact/numbers.ts
// cycles documented in those files' headers): this module constructs `new AExact` only
// inside function BODIES (`mintExact`), and AExact.ts calls this module's
// helpers only inside its own method bodies — nothing touches the other at
// module-eval/class-definition time, so the cycle never observes a not-yet-initialized
// binding.
import { ArrivalError, type ErrorClass, type SourceLocation } from "../errors.js";
import { AExact } from "./primitives/AExact.js";
import { EMPTY_PROVENANCE } from "./primitives/AValue.js";

// ============================================================================
// The overflow door (§0.3 — crash-on-overflow, never silent coercion)
// ============================================================================

/**
 * The teaching door for §0.3's crash-on-overflow law: an exact result (or an
 * intermediate a rational op needed along the way, e.g. a cross-multiplied
 * denominator) left the safe-integer range. Never thrown for a non-integral exact
 * DIVISION result — constructing `1/3` is ordinary, silent rational formation, not an
 * event (§2.0) — only when a NUMERATOR or DENOMINATOR component itself would overflow.
 */
export class ExactOverflowError extends ArrivalError {
  // Interop boundary: covered by the nominal `instanceof ArrivalError` family rule
  // in interop-access.ts — no per-class stamp needed.
  public readonly name = "ExactOverflowError";
  readonly "arrival/error-category": ErrorClass = "exact-overflow";

  constructor(
    /** The operation that overflowed, e.g. "exact +", "quotient" — omitted when the
     *  caller didn't thread one through; the message still teaches without it. */
    public readonly op: string | undefined,
    public readonly magnitude: string,
  ) {
    super(
      `exact overflow${op ? ` in ${op}` : ""}: ${magnitude} exceeds safe-integer components — ` +
        `use inexact operands (1.0, exact->inexact) if approximation is acceptable`,
    );
  }
}

function overflow(op: string | undefined, magnitude: number): never {
  throw new ExactOverflowError(op, String(magnitude));
}

/** Safe-int gate for a single already-computed intermediate. Throws
 *  {@link ExactOverflowError} — never coerces, never warns (§0.3). */
function checked(value: number, op: string | undefined): number {
  if (!Number.isSafeInteger(value)) overflow(op, value);
  return value;
}

/** `a*b`, safe-int-checked. The building block for every cross-multiplied rational op:
 *  denominators (`b*d`), the `a*d`/`b*c` cross terms of add/sub, `expt`'s repeated-mult
 *  fold, `lcm`'s `a/g*b`. */
export function checkedMul(a: number, b: number, op?: string): number {
  return checked(a * b, op);
}

/** `a+b`, safe-int-checked (the `ad+bc` numerator sum of rational add). */
export function checkedAdd(a: number, b: number, op?: string): number {
  return checked(a + b, op);
}

/** `a-b`, safe-int-checked (the `ad-bc` numerator difference of rational sub). */
export function checkedSub(a: number, b: number, op?: string): number {
  return checked(a - b, op);
}

// ============================================================================
// DEBUG belt — process.env.ARRIVAL_NUMERIC_DEBUG (test builds only)
// ============================================================================

/**
 * Is the DEBUG bigint cross-check live? Gate every call site behind this rather than
 * unconditionally calling {@link debugCrossCheckRational}, so the BigInt reference
 * computation isn't even built when the flag is off — zero production cost, the whole
 * belt compiles away to a single boolean check per op.
 */
export function isNumericDebugEnabled(): boolean {
  return typeof process !== "undefined" && !!process.env?.ARRIVAL_NUMERIC_DEBUG;
}

export type RationalOp = "add" | "sub" | "mul" | "div";

function bigIntGcd(a: bigint, b: bigint): bigint {
  a = a < 0n ? -a : a;
  b = b < 0n ? -b : b;
  while (b !== 0n) {
    const t = b;
    b = a % b;
    a = t;
  }
  return a;
}

/**
 * Cross-checks a rational op's float-path result (`resultNum`/`resultDenom`, already
 * gcd-reduced by the `AExact` constructor) against the same op computed via BigInt — a
 * representation with no float-precision hazard at all, i.e. the reference answer.
 * A mismatch means the safe-operand invariant leaked somewhere upstream (an unguarded
 * mint path let an already-imprecise operand through the checked helpers above) and
 * throws loudly rather than silently shipping a wrong exact. Test-build belt only —
 * always call behind {@link isNumericDebugEnabled}.
 */
export function debugCrossCheckRational(
  op: RationalOp,
  aNum: number,
  aDenom: number,
  bNum: number,
  bDenom: number,
  resultNum: number,
  resultDenom: number,
): void {
  const an = BigInt(aNum);
  const ad = BigInt(aDenom);
  const bn = BigInt(bNum);
  const bd = BigInt(bDenom);
  let expectNum: bigint;
  let expectDenom: bigint;
  switch (op) {
    case "add":
      expectNum = an * bd + bn * ad;
      expectDenom = ad * bd;
      break;
    case "sub":
      expectNum = an * bd - bn * ad;
      expectDenom = ad * bd;
      break;
    case "mul":
      expectNum = an * bn;
      expectDenom = ad * bd;
      break;
    case "div":
      expectNum = an * bd;
      expectDenom = ad * bn;
      break;
  }
  if (expectDenom < 0n) {
    expectNum = -expectNum;
    expectDenom = -expectDenom;
  }
  const g = bigIntGcd(expectNum, expectDenom);
  const normNum = g === 0n ? 0n : expectNum / g;
  const normDenom = g === 0n ? 1n : expectDenom / g;
  if (normNum !== BigInt(resultNum) || normDenom !== BigInt(resultDenom)) {
    throw new Error(
      `ARRIVAL_NUMERIC_DEBUG: exact ${op} mismatch — float path gave ${resultNum}/${resultDenom}, ` +
        `BigInt reference gives ${normNum}/${normDenom} (operands ${aNum}/${aDenom}, ${bNum}/${bDenom})`,
    );
  }
}

// ============================================================================
// The mint choke-point
// ============================================================================

/**
 * The ONE mint choke-point for a checked exact rational (§2.1). `num`/`denom` should
 * already be individually safe-int (callers producing them via arithmetic pre-check
 * cross-multiplied intermediates with `checkedMul`/`checkedAdd`/`checkedSub` above) —
 * this is the FINAL gate, re-verified here too since a caller may reach this directly
 * from an already-safe value (a literal, a parsed token) that never went through the
 * checked helpers. Throws {@link ExactOverflowError} — crash-on-overflow, never a
 * silent coercion (§0.3). Zero-denominator still throws via the `AExact` constructor's
 * own "Division by zero" invariant (unrelated to overflow — not this function's door).
 */
export function mintExact(
  num: number,
  denom: number,
  provenance: ReadonlySet<number> = EMPTY_PROVENANCE,
  op?: string,
  /** Source span for a reader-minted literal — the parser's leaf-literal parsers
   *  (parsing.ts) are the only callers that pass one; every arithmetic-result mint
   *  omits it (a computed value has no source span of its own). */
  location?: SourceLocation,
): AExact {
  if (!Number.isSafeInteger(num)) overflow(op, num);
  if (!Number.isSafeInteger(denom)) overflow(op, denom);
  return new AExact(num, denom, provenance, location);
}
