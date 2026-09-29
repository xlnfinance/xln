/**
 * R7RS numeric core — each op bound via `symbol.native` (LOOSE types-only
 * contract; the impl IS the binding, capability.ts `case "native"`).
 *
 * `nativeNumericOp` — pack's per-op wrapper, three concerns inline:
 *   1. provenance — union AValue inputs, stamp result; boolean verdicts via R8
 *      mint (`mintVerdict`: flyweight when provenance-free, fresh ABool otherwise);
 *   2. coercion + error-naming — `coerceNumeric` each arg, naming the bad index;
 *   3. codec marshalling — per-arg decode → `fn` → `out.fromJS`.
 *
 * `NumSpec.in`/`inRest`/`out` are real `z.ZodTypeAny` schemas from scheme-zod.ts —
 * ONE vocabulary, consumed by both `marshalCall` (runtime) and `contractFromSpec`
 * (type-inference face). `marshalCall`'s doc below carries the two identity
 * special-cases (`z.schemeNumber`, `z.boolean`) this surfaces.
 *
 * Comparison ops resolve directly through the numeric core — no Tier-2 HalfBaked
 * speculative evaluation branch exists for them.
 */

import * as z from "../../common/scheme-zod/index.js";
import dedent from "dedent";
import invariant from "tiny-invariant";
// `TypeError.invariant` is a global augmentation — import explicitly so correctness
// doesn't depend on load order.
import "@here.build/error-invariant";
import type { Contract, RestSpec, VectorSpec } from "../../common/symbols/_bake.js";
import { EnvCapability } from "../../common/capability.js";
import type { EmitCtx, EmitRule } from "../../emit/emit-rule.js";
import { Bin, Binding, Call, Lit, Method, Ref, Un, type BinOp, type R } from "../../emit/residual-lite.js";
import type { RunContext } from "../../run/RunContext.js";
import { CallCtx } from "../../run/CallCtx.js";
import { AValue, EMPTY_PROVENANCE, unionProvenance } from "../../values/primitives/AValue.js";
import type { ABool } from "../../values/primitives/ABool.js";
import { AExact } from "../../values/primitives/AExact.js";
import { AInexact } from "../../values/primitives/AInexact.js";
import { AString } from "../../values/primitives/AString.js";
import { APair } from "../../values/primitives/APair.js";
import type { SchemeValue } from "../../values/types.js";
import { type ANumeric, exactISqrt, complexDoor, isComplex, schemeCompare, toReal } from "../../values/numbers.js";
import {
  coerceNumeric,
  isSchemeNumber,
  isOrd,
  ORD_REL,
  nilOrderCompare,
  mintVerdict,
  isEagerAccumulationActive,
  type AOrd,
} from "../../values/op-helpers.js";
import { checkedMul, mintExact } from "../../values/mint-numeric.js";
import { type } from "../../membrane/typecheck.js";
import { tf } from "../../values/tagless-final.js";

// ════════════════════════════════════════════════════════════════════════════
// nativeNumericOp — pack's per-op wrapper (R8 mintVerdict, A4 always-box).
// ════════════════════════════════════════════════════════════════════════════

interface NumSpec {
  in: z.ZodTypeAny[];
  inRest?: z.ZodTypeAny;
  out: z.ZodTypeAny;
  fn: (...jsArgs: any[]) => any;
  /** Zero-arg identity mint — ONLY `+`/`*` (`(+)` ⇒ 0, `(*)` ⇒ 1) declare this.
   * The identity literal must carry the invoking run's ctx, never CONSTANT_CTX, and
   * `fn`'s own signature has no ctx parameter — so `marshalCall` intercepts the
   * zero-arg case BEFORE calling `fn`, minting the identity here under the real
   * runCtx it's threaded (never falls through to `fn`, which stays unreachable
   * on zero args — see addFn/mulFn below). */
  zeroArgIdentity?: (ctx: RunContext) => unknown;
}

/**
 * Per-arg DECODE (scheme → JS) via the schema's own `.safeParse` (uniform-vocabulary
 * ruling — the schema IS the NCodec `match`+`toJS` fusion). Two runtime realities:
 *  1. `.safeParse` does NOT catch a raw THROW from a codec's `decode` — codecs here
 *     use `Error.invariant`/`TypeError.invariant` (bare `throw`, not `ctx.addIssue`),
 *     so a mismatch surfaces as EITHER `{success:false}` OR an uncaught exception;
 *     both normalize to the SAME `${name}: argument ${index} type mismatch` door.
 *  2. `z.schemeNumber` → IDENTITY. Its real decode unwraps AExact/AInexact to a raw
 *     bigint/number (and its `exact` half DOORS on non-integer rationals) — wrong for
 *     SchemeNum-role fns, which already hold a `coerceNumeric`d ANumeric. `===` is
 *     safe: `z.schemeNumber` is a module singleton.
 */
function decodeArg(name: string, index: number, schema: z.ZodTypeAny, arg: unknown): unknown {
  if ((schema as unknown) === z.schemeNumber) {
    TypeError.invariant(arg instanceof AExact || arg instanceof AInexact, `${name}: argument ${index} type mismatch`);
    return arg;
  }
  let result: { success: boolean; data?: unknown };
  try {
    result = schema.safeParse(arg);
  } catch {
    result = { success: false };
  }
  TypeError.invariant(result.success, `${name}: argument ${index} type mismatch`);
  return result.data;
}

/**
 * Encode a JS result to a scheme value via `z.encode` — the SAME `z.schemeNumber`
 * identity special case as `decodeArg`, PLUS `z.boolean`: its real encode mints a
 * fresh `ABool`, but `nativeNumericOp`'s R8 `mintVerdict` step owns that boxing (the
 * union of the CALL's operand provenance, not a single result's) — an ABool minted
 * here would be the wrong box, silently overwritten downstream.
 */
function encodeResult(schema: z.ZodTypeAny, result: unknown): unknown {
  if ((schema as unknown) === z.schemeNumber || (schema as unknown) === z.boolean) return result;
  return z.encode(schema, result as never);
}

/**
 * Raw marshalling — arity guard + per-arg schema decode + `fn` + output encode,
 * WITHOUT the provenance/coerce layer. `nativeNumericOp` runs it after coercion;
 * inline misc ops (`lcm`, `>>`, `<<`) run it too (bypass provenance); `floor/`/
 * `truncate/` skip it and call the carved fns directly.
 */
function marshalCall(name: string, spec: NumSpec, args: unknown[], runCtx?: RunContext): unknown {
  const { in: inSchemas, inRest, out, fn, zeroArgIdentity } = spec;
  const minArgs = inSchemas.length;
  TypeError.invariant(args.length >= minArgs, `${name}: expected at least ${minArgs} args, got ${args.length}`);
  TypeError.invariant(inRest || args.length <= minArgs, `${name}: expected ${minArgs} args, got ${args.length}`);
  if (args.length === 0 && zeroArgIdentity) {
    invariant(runCtx, `${name}: zero-arg identity mint requires the invoking run's ctx`);
    return encodeResult(out, zeroArgIdentity(runCtx));
  }
  const jsArgs = args.map((arg, i) => {
    const schema = i < inSchemas.length ? inSchemas[i] : inRest!;
    return decodeArg(name, i, schema, arg);
  });
  const jsResult = fn(...jsArgs);
  return encodeResult(out, jsResult);
}

function nativeNumericOp(name: string, spec: NumSpec): (this: CallCtx, ...args: unknown[]) => unknown {
  const applyNumeric = (callArgs: unknown[], runCtx: RunContext): unknown => {
    // Gated on the SAME effective switch `withInputProvenance` uses
    // (`isEagerAccumulationActive` — ambient flag OR silent-region γ, op-helpers.ts's
    // own doc), so arithmetic ops honor the eager-accumulation default AND still
    // accumulate correctly inside a replay's hermetic re-execution.
    const provenance = isEagerAccumulationActive()
      ? unionProvenance(callArgs.filter((a): a is AValue => a instanceof AValue))
      : EMPTY_PROVENANCE;
    let converted: ANumeric[];
    try {
      converted = callArgs.map((arg) => coerceNumeric(arg, runCtx));
    } catch (error) {
      // Name what actually failed — mirror isSchemeNumber's contract.
      const badIndex = callArgs.findIndex((a) => !isSchemeNumber(a));
      const typeNames = callArgs.map(type).join(", ");
      const detail = badIndex === -1 ? "argument type mismatch" : `argument ${badIndex} is ${type(callArgs[badIndex])}`;
      throw new TypeError(`Cannot apply ${name} to (${typeNames}): ${detail}`, { cause: error });
    }
    const result: unknown = marshalCall(name, spec, converted, runCtx);
    if (provenance.size > 0 && result instanceof AValue) return result.withProvenance(provenance);
    // R8 mint (RULINGS.md R8, op-helpers.mintVerdict): every boolean verdict boxes —
    // provenance-free operands get the eq?-stable flyweight, stamped operands a fresh
    // ABool carrying the union.
    if (typeof result === "boolean") return mintVerdict(callArgs, result);
    return result;
  };

  const fn = function (this: CallCtx, ...args: unknown[]): unknown {
    return applyNumeric(args, this.runCtx);
  };
  Object.defineProperty(fn, "name", { value: name });
  return fn;
}

/**
 * R7RS tower-type predicates (`complex?`/`real?`/`rational?`/`integer?`/`exact?`/…/
 * `nan?`) — total over the value domain (a non-number returns #f, never an error).
 * R8 mint (op-helpers.mintVerdict): boxes + forwards `value`'s provenance —
 * `symbol.native`'s `"native"` kind binds the return raw (no codec crossing), so an
 * unboxed `boolean` would be a bare value inside the membrane (P4), not just an
 * allocation shortcut.
 */
function nativeTypePredicate(name: string, predicate: (n: ANumeric) => boolean): (...args: unknown[]) => unknown {
  const fn = (value: unknown): ABool => {
    if (!isSchemeNumber(value)) {
      return mintVerdict([value], false);
    }
    try {
      // ctx-neutral by design: `converted` is consulted for its numeric SHAPE only
      // (predicate(converted) is a boolean test) and never escapes as a value —
      // coerceNumeric's default ctx param is inert here, unlike the mint-and-return
      // sites elsewhere in this file.
      const converted = coerceNumeric(value);
      return mintVerdict([value], predicate(converted));
    } catch {
      return mintVerdict([value], false);
    }
  };
  Object.defineProperty(fn, "name", { value: name });
  return fn;
}

// ════════════════════════════════════════════════════════════════════════════
// Operator implementations — fn bodies.
// ════════════════════════════════════════════════════════════════════════════

// ── Arithmetic helpers (exactness-preserving) ───────────────────────────────────

function schemeAdd(a: ANumeric, b: ANumeric): ANumeric {
  if (a instanceof AInexact || b instanceof AInexact) {
    const aVal = a instanceof AExact ? a.valueOf() : a.real;
    const bVal = b instanceof AExact ? b.valueOf() : b.real;
    return new AInexact(aVal + bVal);
  }
  return (a as AExact).add(b as AExact);
}

function schemeSub(a: ANumeric, b: ANumeric): ANumeric {
  if (a instanceof AInexact || b instanceof AInexact) {
    const aVal = a instanceof AExact ? a.valueOf() : a.real;
    const bVal = b instanceof AExact ? b.valueOf() : b.real;
    return new AInexact(aVal - bVal);
  }
  return (a as AExact).sub(b as AExact);
}

function schemeNegate(a: ANumeric): ANumeric {
  if (a instanceof AInexact) {
    return new AInexact(-a.real);
  }
  return a.neg();
}

function schemeMul(a: ANumeric, b: ANumeric): ANumeric {
  if (a instanceof AInexact || b instanceof AInexact) {
    const aVal = a instanceof AExact ? a.valueOf() : a.real;
    const bVal = b instanceof AExact ? b.valueOf() : b.real;
    return new AInexact(aVal * bVal);
  }
  return (a as AExact).mul(b as AExact);
}

function schemeDiv(a: ANumeric, b: ANumeric): ANumeric {
  if (a instanceof AInexact || b instanceof AInexact) {
    const aVal = a instanceof AExact ? a.valueOf() : a.real;
    const bVal = b instanceof AExact ? b.valueOf() : b.real;
    return new AInexact(aVal / bVal);
  }
  return (a as AExact).div(b as AExact);
}

// Zero-arg case is intercepted by marshalCall's `zeroArgIdentity` (below the spec)
// BEFORE `fn` is ever called — this always sees at least one operand.
const addFn = (...args: ANumeric[]): ANumeric => args.reduce(schemeAdd);

const subFn = (first: ANumeric, ...rest: ANumeric[]): ANumeric => {
  if (rest.length === 0) return schemeNegate(first);
  return rest.reduce(schemeSub, first);
};

const mulFn = (...args: ANumeric[]): ANumeric => args.reduce(schemeMul);

const divFn = (first: ANumeric, ...rest: ANumeric[]): ANumeric => {
  if (rest.length === 0) {
    return schemeDiv(new AExact(1), first);
  }
  return rest.reduce(schemeDiv, first);
};

// ── Integer division family ─────────────────────────────────────────────────────
// Everything below is plain `number` (§2.0/§2.1 — RATIO, both AExact fields
// safe-int by construction): one path per helper, `exact`-tagged only to thread
// contagion (bothExact) into the caller's AExact-vs-AInexact choice.

/** `a - (a % b)` divides `b` EXACTLY (by construction of `%`), so the IEEE division
 *  below is exact whenever the true quotient is itself a safe integer — mirrors
 *  `AExact.quotient`'s own technique, never `Math.trunc(a/b)` directly. */
function truncDiv(a: number, b: number): number {
  const r = a % b;
  return (a - r) / b;
}

function floorDiv(a: number, b: number): number {
  const q = truncDiv(a, b);
  const r = a % b;
  if (r !== 0 && a < 0 !== b < 0) return q - 1;
  return q;
}

function toInteger(n: ANumeric, opName: string): { value: number; exact: boolean } {
  if (n instanceof AExact) {
    TypeError.invariant(n.denom === 1, `${opName}: not an integer`);
    return { value: n.num, exact: true };
  }
  TypeError.invariant(Number.isInteger(n.real), `${opName}: not an integer`);
  return { value: n.real, exact: false };
}

function toIntegerPair(a: ANumeric, b: ANumeric, opName: string): { bothExact: boolean; av: number; bv: number } {
  const ai = toInteger(a, opName);
  const bi = toInteger(b, opName);
  return { bothExact: ai.exact && bi.exact, av: ai.value, bv: bi.value };
}

function boxInteger(exact: boolean, value: number): ANumeric {
  return exact ? new AExact(value) : new AInexact(value);
}

const quotientFn = (a: ANumeric, b: ANumeric): ANumeric => {
  const p = toIntegerPair(a, b, "quotient");
  invariant(p.bv !== 0, "quotient: division by zero");
  return boxInteger(p.bothExact, truncDiv(p.av, p.bv));
};

const remainderFn = (a: ANumeric, b: ANumeric): ANumeric => {
  const p = toIntegerPair(a, b, "remainder");
  invariant(p.bv !== 0, "remainder: division by zero");
  return boxInteger(p.bothExact, p.av % p.bv);
};

const moduloFn = (a: ANumeric, b: ANumeric): ANumeric => {
  const p = toIntegerPair(a, b, "modulo");
  invariant(p.bv !== 0, "modulo: division by zero");
  return boxInteger(p.bothExact, ((p.av % p.bv) + p.bv) % p.bv);
};

const floorQuotientFn = (a: ANumeric, b: ANumeric): ANumeric => {
  const p = toIntegerPair(a, b, "floor-quotient");
  invariant(p.bv !== 0, "floor-quotient: division by zero");
  return boxInteger(p.bothExact, floorDiv(p.av, p.bv));
};

const floorRemainderFn = (a: ANumeric, b: ANumeric): ANumeric => {
  const p = toIntegerPair(a, b, "floor-remainder");
  invariant(p.bv !== 0, "floor-remainder: division by zero");
  return boxInteger(p.bothExact, ((p.av % p.bv) + p.bv) % p.bv);
};

const truncateQuotientFn = (a: ANumeric, b: ANumeric): ANumeric => {
  const p = toIntegerPair(a, b, "truncate-quotient");
  invariant(p.bv !== 0, "truncate-quotient: division by zero");
  return boxInteger(p.bothExact, truncDiv(p.av, p.bv));
};

const truncateRemainderFn = (a: ANumeric, b: ANumeric): ANumeric => {
  const p = toIntegerPair(a, b, "truncate-remainder");
  invariant(p.bv !== 0, "truncate-remainder: division by zero");
  return boxInteger(p.bothExact, p.av % p.bv);
};

// abs/zero?/positive?/negative? — box-native (§2.2 encode-edge law): operate on the
// already-coerced ANumeric and return/answer directly off ITS OWN exactness, never
// round-trip through a shape-guessing loose codec (a plain JS `number` result of an
// op has no memory of which box it came from — `Number.isSafeInteger` cannot recover
// "was the operand exact" once the value is unboxed).
function schemeAbs(x: ANumeric): ANumeric {
  return x instanceof AExact ? x.abs() : new AInexact(Math.abs(x.real));
}

// ── gcd / lcm ───────────────────────────────────────────────────────────────────

function gcd2(a: number, b: number): number {
  a = a < 0 ? -a : a;
  b = b < 0 ? -b : b;
  while (b !== 0) {
    const t = b;
    b = a % b;
    a = t;
  }
  return a;
}

/** gcd/lcm are box-native for the SAME reason `schemeAbs` is (§2.2): a variadic fold
 *  over `toInteger`'d operands, contagion tracked via `hasInexact` so a single inexact
 *  argument makes the whole result inexact even when the accumulated magnitude happens
 *  to be an integer — `(exact? (gcd 4.0 6))` must be `#f`. Zero-arg identity (R7RS: 0)
 *  is intercepted by `marshalCall`'s `zeroArgIdentity` before `fn` is ever called, so
 *  `args` here always has ≥1 element. */
const gcdFn = (...args: ANumeric[]): ANumeric => {
  let acc = 0;
  let hasInexact = false;
  for (const n of args) {
    const { value, exact } = toInteger(n, "gcd");
    if (!exact) hasInexact = true;
    acc = gcd2(acc, value);
  }
  return boxInteger(!hasInexact, acc);
};

/** `lcm(a,b) = (a/g)*b` where `g = gcd(a,b)` — the DIVIDE-then-multiply order (never
 *  `(a*b)/g`) so the checked multiply below only ever guards the FINAL product, not an
 *  intermediate that could overflow before the gcd ever reduces it (§2.1: "lcm (a/g*b,
 *  checked product)"). Zero-arg identity (R7RS: 1) via `marshalCall`, same as gcd. */
const lcmFn = (...args: ANumeric[]): ANumeric => {
  let acc = 1;
  let hasInexact = false;
  for (const n of args) {
    const { value, exact } = toInteger(n, "lcm");
    if (!exact) hasInexact = true;
    const av = value < 0 ? -value : value;
    const g = gcd2(acc, av);
    acc = g === 0 ? 0 : checkedMul(acc / g, av, "lcm");
  }
  return boxInteger(!hasInexact, acc);
};

// ── expt ─────────────────────────────────────────────────────────────────────────

/** `base**exponent` via a checked repeated-mult fold (§2.1: "expt (repeated-mult with
 *  per-step check)") — never the bare `**` operator, which would silently produce an
 *  imprecise/overflowed float with no crash-on-overflow gate. `exponent` is always a
 *  non-negative safe-int here (schemeExpt's own `n >= 0`/`m = -n` split). Fast paths
 *  for |base| ≤ 1 avoid looping the full exponent magnitude when the result is bounded
 *  regardless (0^n, 1^n, (-1)^n) — exponents can themselves be up to 2^53. */
function checkedPow(base: number, exponent: number, op: string): number {
  if (base === 0) return exponent === 0 ? 1 : 0;
  if (base === 1) return 1;
  if (base === -1) return exponent % 2 === 0 ? 1 : -1;
  let result = 1;
  for (let i = 0; i < exponent; i++) {
    result = checkedMul(result, base, op);
  }
  return result;
}

function schemeExpt(base: ANumeric, power: ANumeric): ANumeric {
  if (base instanceof AExact && power instanceof AExact && power.denom === 1) {
    const n = power.num;
    if (n >= 0) {
      return mintExact(checkedPow(base.num, n, "expt"), checkedPow(base.denom, n, "expt"), undefined, "expt");
    }
    invariant(base.num !== 0, "expt: division by zero (0 raised to a negative power)");
    const m = -n;
    return mintExact(checkedPow(base.denom, m, "expt"), checkedPow(base.num, m, "expt"), undefined, "expt");
  }
  return new AInexact(Math.pow(toReal(base), toReal(power)));
}

// ── Comparison cores ─────────────────────────────────────────────────────────────

function schemeNumEq(a: ANumeric, b: ANumeric): boolean {
  if (a instanceof AExact && b instanceof AExact) {
    return a.cmp(b) === 0;
  }
  return toReal(a) === toReal(b);
}

const numEqFn = (first: ANumeric, ...rest: ANumeric[]): boolean => {
  return rest.every((x) => schemeNumEq(first, x));
};

const ltFn = (first: ANumeric, ...rest: ANumeric[]): boolean => {
  let prev = first;
  for (const x of rest) {
    if (!(schemeCompare(prev, x) < 0)) return false;
    prev = x;
  }
  return true;
};

const gtFn = (first: ANumeric, ...rest: ANumeric[]): boolean => {
  let prev = first;
  for (const x of rest) {
    if (!(schemeCompare(prev, x) > 0)) return false;
    prev = x;
  }
  return true;
};

const lteFn = (first: ANumeric, ...rest: ANumeric[]): boolean => {
  let prev = first;
  for (const x of rest) {
    // NaN ⇒ schemeCompare returns NaN ⇒ `NaN <= 0` is false ⇒ short-circuit.
    if (!(schemeCompare(prev, x) <= 0)) return false;
    prev = x;
  }
  return true;
};

const gteFn = (first: ANumeric, ...rest: ANumeric[]): boolean => {
  let prev = first;
  for (const x of rest) {
    if (!(schemeCompare(prev, x) >= 0)) return false;
    prev = x;
  }
  return true;
};

// ── max / min ────────────────────────────────────────────────────────────────────

const maxFn = (first: ANumeric, ...rest: ANumeric[]): ANumeric => {
  let extreme = first;
  let hasInexact = first instanceof AInexact;
  for (const x of rest) {
    if (x instanceof AInexact) hasInexact = true;
    if (schemeCompare(x, extreme) > 0) extreme = x;
  }
  return hasInexact && extreme instanceof AExact ? extreme.toInexact() : extreme;
};

const minFn = (first: ANumeric, ...rest: ANumeric[]): ANumeric => {
  let extreme = first;
  let hasInexact = first instanceof AInexact;
  for (const x of rest) {
    if (x instanceof AInexact) hasInexact = true;
    if (schemeCompare(x, extreme) < 0) extreme = x;
  }
  return hasInexact && extreme instanceof AExact ? extreme.toInexact() : extreme;
};

// ── Predicates ────────────────────────────────────────────────────────────────────
// Box-native (§2.2 — same reasoning as schemeAbs): AExact/AInexact both carry
// isZero/isPositive/isNegative getters directly, so no shape-guessing codec is
// involved at all — sign predicates never touch encode.

const isZeroFn = (x: ANumeric): boolean => x.isZero;
const isPositiveFn = (x: ANumeric): boolean => x.isPositive;
const isNegativeFn = (x: ANumeric): boolean => x.isNegative;
const isOddFn = (x: number): boolean => x % 2 !== 0;
const isEvenFn = (x: number): boolean => x % 2 === 0;

// ── Rounding ──────────────────────────────────────────────────────────────────────

const roundFn = (x: number): number => {
  // R7RS: round to even on ties (banker's rounding).
  const floored = Math.floor(x);
  const ceiled = Math.ceil(x);
  const diff = x - floored;
  if (diff < 0.5) return floored;
  if (diff > 0.5) return ceiled;
  if (floored % 2 === 0) return floored;
  return ceiled;
};

// floor/ceiling/truncate/round are box-native too (§2.2): AExact already carries these
// as methods (AExact.ts), so routing through them — rather than a raw `z.looseNumber`
// in/out spec — means an inexact operand can never come back exact just because its
// rounded VALUE happens to be a safe integer (`(exact? (floor 2.5))` must be `#f`).
function schemeFloor(x: ANumeric): ANumeric {
  return x instanceof AExact ? x.floor() : new AInexact(Math.floor(x.real));
}
function schemeCeiling(x: ANumeric): ANumeric {
  return x instanceof AExact ? x.ceiling() : new AInexact(Math.ceil(x.real));
}
function schemeTruncate(x: ANumeric): ANumeric {
  return x instanceof AExact ? x.truncate() : new AInexact(Math.trunc(x.real));
}
function schemeRound(x: ANumeric): ANumeric {
  return x instanceof AExact ? x.round() : new AInexact(roundFn(x.real));
}

// ── Rational accessors ──────────────────────────────────────────────────────────────

/** Exact rational nearest a finite, non-integer double, read off its OWN decimal
 *  string (handles both fixed ("0.5") and exponential ("1e-10") `Number.toString()`
 *  forms) — shared by numerator/denominator's inexact arm and `inexact->exact`.
 *  `Number(...)` parses of a ≤17-significant-digit string are exact for magnitudes
 *  within the safe-integer ceiling (the common case); the guard below doors rather
 *  than silently rounding a mantissa/scale that lands outside it. */
function floatToRational(x: number): { num: number; denom: number } {
  invariant(Number.isFinite(x), "requires a finite number");
  if (Number.isInteger(x)) return { num: x, denom: 1 };
  const str = x.toString();
  const expMatch = str.match(/^(-?)(\d+)(?:\.(\d+))?e([+-]?\d+)$/i);
  if (expMatch) {
    const [, sign, intPart, fracPart = "", expStr] = expMatch;
    const exp = Number(expStr);
    const digits = intPart + fracPart;
    const netExp = exp - fracPart.length;
    const mantissa = Number(`${sign}${digits}`);
    TypeError.invariant(Number.isSafeInteger(mantissa), `${x}: precision exceeds safe-integer representation`);
    if (netExp >= 0) return { num: checkedMul(mantissa, 10 ** netExp, "exact"), denom: 1 };
    const denom = 10 ** -netExp;
    TypeError.invariant(Number.isSafeInteger(denom), `${x}: precision exceeds safe-integer representation`);
    const g = gcd2(mantissa < 0 ? -mantissa : mantissa, denom);
    return { num: mantissa / g, denom: denom / g };
  }
  const dotIndex = str.indexOf(".");
  if (dotIndex === -1) return { num: x, denom: 1 };
  const decimals = str.length - dotIndex - 1;
  const denom = 10 ** decimals;
  const numAbs = Number(str.replace(".", "").replace(/^-/, ""));
  TypeError.invariant(
    Number.isSafeInteger(denom) && Number.isSafeInteger(numAbs),
    `${x}: precision exceeds safe-integer representation`,
  );
  const sign = x < 0 ? -1 : 1;
  const g = gcd2(numAbs, denom);
  return { num: sign * (numAbs / g), denom: denom / g };
}

const numeratorFn = (x: ANumeric): ANumeric => {
  if (x instanceof AExact) {
    return new AExact(x.num);
  }
  invariant(x instanceof AInexact, "numerator requires a rational number");
  const { num } = floatToRational(x.real);
  return new AInexact(num);
};

const denominatorFn = (x: ANumeric): ANumeric => {
  if (x instanceof AExact) {
    return new AExact(x.denom);
  }
  invariant(x instanceof AInexact, "denominator requires a rational number");
  const { denom } = floatToRational(x.real);
  return new AInexact(denom);
};

// ── R7RS S2 gaps: square / exact-integer-sqrt / rationalize ─────────────────────────

const squareFn = (x: ANumeric): ANumeric => schemeMul(x, x);

/** R7RS exact-integer-sqrt: (s . r) with s² ≤ n < (s+1)² and n = s² + r. Product pair.
 *  `s*s`/`s²` can't overflow: `exactISqrt`'s own contract guarantees `s*s ≤ n`, and `n`
 *  is already a safe-int AExact field — no checked helper needed. */
const exactIntegerSqrtFn = function (this: CallCtx, n: unknown): APair<AExact, AExact> {
  const a = coerceNumeric(n, this.runCtx);
  invariant(a instanceof AExact && a.denom === 1, "exact-integer-sqrt: exact integer required");
  invariant(a.num >= 0, "exact-integer-sqrt: non-negative integer required");
  const s = exactISqrt(a.num);
  const r = a.num - s * s;
  return new APair(new AExact(s), new AExact(r));
};

/** Simplest rational in [x, y] (x ≤ y). R7RS-style recursive invert of fractional parts. */
function simplestInRange(x: number, y: number): { num: number; denom: number } {
  if (y < x) return simplestInRange(y, x);
  if (x <= 0 && y >= 0) return { num: 0, denom: 1 };
  if (y < 0) {
    const n = simplestInRange(-y, -x);
    return { num: -n.num, denom: n.denom };
  }
  if (x < 0) return simplestInRange(0, y);
  const fx = Math.floor(x);
  // x is integer (at left bound)
  if (fx >= x) return { num: fx, denom: 1 };
  // an integer lies strictly between x and y
  if (fx + 1 <= y) return { num: fx + 1, denom: 1 };
  // same integer part: n + 1/q where q is simplest in inverted fractional range
  const inv = simplestInRange(1 / (y - fx), 1 / (x - fx));
  // n + 1/(p/q) = n + q/p = (n*p + q)/p
  return { num: fx * inv.num + inv.denom, denom: inv.num };
}

const rationalizeFn = function (this: CallCtx, x: unknown, e: unknown): ANumeric {
  const xv = coerceNumeric(x, this.runCtx);
  const ev = coerceNumeric(e, this.runCtx);
  const xr = toReal(xv);
  const er = Math.abs(toReal(ev));
  invariant(Number.isFinite(xr) && Number.isFinite(er), "rationalize: finite reals required");
  const { num, denom } = simplestInRange(xr - er, xr + er);
  if (xv instanceof AExact && ev instanceof AExact) {
    return new AExact(num, denom);
  }
  return new AInexact(num / denom);
};

// ── Transcendentals ─────────────────────────────────────────────────────────────────

const sqrtFn = (x: ANumeric): ANumeric => {
  const val = x instanceof AExact ? x.valueOf() : x.real;
  if (val < 0) {
    complexDoor();
  }
  if (x instanceof AExact && x.denom === 1 && x.num >= 0) {
    const r = exactISqrt(x.num);
    if (r * r === x.num) {
      return new AExact(r);
    }
  }
  return new AInexact(Math.sqrt(val));
};

const logFn = (z: number, base?: number): number => (base === undefined ? Math.log(z) : Math.log(z) / Math.log(base));
const atanFn = (y: number, x?: number): number => (x === undefined ? Math.atan(y) : Math.atan2(y, x));

// ── Bitwise — DOORED: here lieth the dragons ─────────────────────────────────────────
// Scheme exact integers are safe-range JS numbers, and JS's native bitwise operators
// (`|` `&` `^` `~` `<<` `>>`) silently coerce their operands to 32 BITS — every result on
// a value wider than 2^31 is silent corruption, precisely the wrong-value class the
// one-number representation (docs/design-history/arrival-one-number-rework.md) exists to
// abolish. Correct wide bitwise needs the arbitrary-precision ALU that representation
// deliberately gave up. Arrival's domain (LLM orchestration) has produced zero demand for
// bitwise (no in-repo .scm uses it); when a real demand lands, implement via split-limb
// words over safe integers — NEVER via the JS operators. Until then: doors, not dragons.
const BITWISE_DOOR =
  "doored under the one-number representation (safe-integer exacts, no bigints): JS bitwise operators truncate to 32 bits — silent corruption above 2^31; here lieth the dragons. See the Bitwise section note in env/r7rs/numeric.ts and arrival-one-number-rework.md";

// ════════════════════════════════════════════════════════════════════════════
// Reused op specs / cores — shared by the canonical R7RS bindings below.
// JS-shaped aliases (`**` `%` `==` `|` `&` `~` `>>` `<<`) live in scheme/sugarcoat.
// ════════════════════════════════════════════════════════════════════════════

const exptSpec: NumSpec = { in: [z.schemeNumber, z.schemeNumber], out: z.schemeNumber, fn: schemeExpt };
const remainderSpec: NumSpec = { in: [z.schemeNumber, z.schemeNumber], out: z.schemeNumber, fn: remainderFn };
const numEqSpec: NumSpec = { in: [z.schemeNumber], inRest: z.schemeNumber, out: z.boolean, fn: numEqFn };

const exptOp = nativeNumericOp("expt", exptSpec);
const remainderOp = nativeNumericOp("remainder", remainderSpec);
const numEqOp = nativeNumericOp("=", numEqSpec);

// The numeric comparison cores (provenance), wrapped by `wrapOrd`
// (FL-Ord fallback) and `looseCompare` (nil-tolerant overlay) below.
const ltSpec: NumSpec = { in: [z.schemeNumber], inRest: z.schemeNumber, out: z.boolean, fn: ltFn };
const gtSpec: NumSpec = { in: [z.schemeNumber], inRest: z.schemeNumber, out: z.boolean, fn: gtFn };
const lteSpec: NumSpec = { in: [z.schemeNumber], inRest: z.schemeNumber, out: z.boolean, fn: lteFn };
const gteSpec: NumSpec = { in: [z.schemeNumber], inRest: z.schemeNumber, out: z.boolean, fn: gteFn };

const ltOp = nativeNumericOp("<", ltSpec);
const gtOp = nativeNumericOp(">", gtSpec);
const lteOp = nativeNumericOp("<=", lteSpec);
const gteOp = nativeNumericOp(">=", gteSpec);

// ════════════════════════════════════════════════════════════════════════════
// Comparison overlay — `wrapOrd` adds FL-Ord fallback (non-numeric ordered
// entities: strings/chars/DateTime/…); `looseCompare` adds nil-tolerant overlay +
// strict-mode gate. Numbers fall through to the numeric core.
// ════════════════════════════════════════════════════════════════════════════

/**
 * Wrap a NUMERIC operator with the FL-Ord fallback. FL-Ord only intercepts NON-NUMERIC
 * ordered entities; a number falls through to `numeric(...)` (ORD_REL is a TOTAL-order
 * shortcut WRONG for the partial numeric order, and the numeric op carries provenance
 * the FL branch can't).
 */
function wrapOrd(
  numeric: (this: CallCtx, ...a: unknown[]) => unknown,
  sym: "<" | ">" | "<=" | ">=",
): (this: CallCtx, ...a: unknown[]) => unknown {
  const rel = ORD_REL[sym];
  const isOrdEntity = (x: unknown): x is AOrd => isOrd(x) && !isSchemeNumber(x);
  // `function(this: CallCtx, …)` (not an arrow) — `looseCompare` below calls this via
  // `core.call(this, …)`, forwarding the SAME ctx `numeric` (ltOp/gtOp/…, itself
  // `this.runCtx`-dependent post the nativeNumericOp rework) needs; an arrow here
  // would silently drop that forwarded `this` on every `numeric(...)` call below.
  const fn = function (this: CallCtx, ...args: unknown[]): unknown {
    if (args.length >= 2 && args.some(isOrdEntity)) {
      let verdict = true;
      for (let i = 0; i < args.length - 1; i++) {
        const a = args[i];
        const b = args[i + 1];
        if (!isOrdEntity(a) || !isOrdEntity(b)) return numeric.call(this, ...args); // mixed → numeric path's clear error
        if (!rel(a, b)) {
          verdict = false;
          break;
        }
      }
      // R8 mint — the whole chain's operand union, not just the deciding pair (mirrors deriveOrd).
      return mintVerdict(args, verdict);
    }
    return numeric.call(this, ...args);
  };
  Object.defineProperty(fn, "name", { value: sym });
  return fn;
}

// ── Loose (nil-tolerant) comparison overlay ──────────────────────────────────────
// Base comparisons throw on nil (coerceNumeric rejects it); inference plane wants
// nil-tolerance (nil operand → #f/nil-as-bottom). Strict mode (RunContext.strict,
// off `this.runCtx`) gates loose off — an all-constant compare like `(= '() '())`
// carries no operand to thread strict, so the run ctx is the only honest source.
const isNilOperand = (v) => v == null || v?.constructor?.name === "ANil";
const isNumberOperand = (v) => v instanceof AExact || v instanceof AInexact;
const flLteNum = (a, b) => a[tf("lte")](b);
const LOOSE_NUM_PAIR = {
  "=": (a, b) => flLteNum(a, b) && flLteNum(b, a),
  "<": (a, b) => flLteNum(a, b) && !flLteNum(b, a),
  ">": (a, b) => flLteNum(b, a) && !flLteNum(a, b),
  "<=": (a, b) => flLteNum(a, b),
  ">=": (a, b) => flLteNum(b, a),
};
const ORD_FROM_LE = {
  "<": (ab, ba) => ab && !ba,
  ">": (ab, ba) => ba && !ab,
  "<=": (ab) => ab,
  ">=": (_ab, ba) => ba,
};
const describeLoose = (v) => (v instanceof AValue ? v.kind : v == null ? String(v) : typeof v);
function loosePairOrder(sym, a, b) {
  const nilCmp = nilOrderCompare(a, b);
  if (nilCmp !== undefined)
    return sym === "<" ? nilCmp < 0 : sym === ">" ? nilCmp > 0 : sym === "<=" ? nilCmp <= 0 : nilCmp >= 0;
  if (isNumberOperand(a) && isNumberOperand(b)) return LOOSE_NUM_PAIR[sym](a, b);
  if (!isOrd(a) || !isOrd(b))
    throw new TypeError(`${sym}: cannot compare ${describeLoose(a)} and ${describeLoose(b)} — no shared order.`);
  const le_ab = Boolean(a[tf("lte")](b));
  const le_ba = Boolean(b[tf("lte")](a));
  if (!le_ab && !le_ba)
    throw new TypeError(`${sym}: cannot compare ${describeLoose(a)} and ${describeLoose(b)} — incompatible types.`);
  return ORD_FROM_LE[sym](le_ab, le_ba);
}
function looseOrderChain(sym, args) {
  let verdict = true;
  for (let i = 0; i < args.length - 1; i++) {
    if (!loosePairOrder(sym, args[i], args[i + 1])) {
      verdict = false;
      break;
    }
  }
  // R8 mint — always boxed, matching applyNumeric/wrapOrd's uniform exit.
  return mintVerdict(args, verdict);
}
function looseCompare(sym, core: (this: CallCtx, ...a: unknown[]) => unknown) {
  // strict rides `this.runCtx` (cannot ride CONSTANT_CTX operands). `core.call(this, …)`
  // required — a bare `core(...)` leaves `this.runCtx` undefined.
  const fn = function (this: CallCtx, ...args) {
    if (this.runCtx.strict === true) {
      if (!args.every(isNumberOperand))
        throw new TypeError(`${sym}: strict mode is R7RS-numeric — a non-number operand is rejected.`);
      return core.call(this, ...args);
    }
    if (args.some(isNilOperand)) {
      // R8 mint — always boxed, matching looseOrderChain's uniform exit.
      if (sym === "=") return mintVerdict(args, args.every(isNilOperand));
      return looseOrderChain(sym, args);
    }
    return core.call(this, ...args);
  };
  Object.defineProperty(fn, "name", { value: sym });
  return fn;
}

// ════════════════════════════════════════════════════════════════════════════
// Inline misc ops — own coercion + `marshalCall` (bypass provenance layer), never
// `nativeNumericOp`.
// ════════════════════════════════════════════════════════════════════════════

// Native impls must be `function` (not arrows) and pass `this.runCtx` into `coerceNumeric`.
// (q . r) product — multi-return is doored on binding. `floorQuotientFn`/
// `floorRemainderFn` accept EITHER ANumeric kind via `toIntegerPair`, so no
// pre-conversion to AExact is needed — the callee re-derives via `toInteger`.
const floorSlashFn = function (this: CallCtx, n1: unknown, n2: unknown): unknown {
  const a = coerceNumeric(n1, this.runCtx);
  const b = coerceNumeric(n2, this.runCtx);
  const q = floorQuotientFn(a, b);
  const r = floorRemainderFn(a, b);
  return new APair(q as SchemeValue, r as SchemeValue);
};

const truncateSlashFn = function (this: CallCtx, n1: unknown, n2: unknown): unknown {
  const a = coerceNumeric(n1, this.runCtx);
  const b = coerceNumeric(n2, this.runCtx);
  const q = truncateQuotientFn(a, b);
  const r = truncateRemainderFn(a, b);
  return new APair(q as SchemeValue, r as SchemeValue);
};

const onePlusFn = function (this: CallCtx, n: unknown): ANumeric {
  const converted = coerceNumeric(n, this.runCtx);
  const one = new AExact(1);
  return addFn(converted, one);
};

const oneMinusFn = function (this: CallCtx, n: unknown): ANumeric {
  const converted = coerceNumeric(n, this.runCtx);
  const one = new AExact(1);
  return subFn(converted, one);
};

const inexactFn = function (this: CallCtx, z: unknown): AInexact {
  const n = coerceNumeric(z, this.runCtx);
  if (n instanceof AInexact) return n;
  return new AInexact(n.num / n.denom);
};

const exactFn = function (this: CallCtx, z: unknown): AExact {
  const n = coerceNumeric(z, this.runCtx);
  if (n instanceof AExact) return n;
  const real = n.real;
  TypeError.invariant(Number.isFinite(real), "Cannot convert infinity or NaN to exact");
  if (Number.isInteger(real)) return mintExact(real, 1, undefined, "inexact->exact");
  const { num, denom } = floatToRational(real);
  return mintExact(num, denom, undefined, "inexact->exact");
};

// Boxed (RULINGS.md R1) — see NUMBER_TO_STRING_CONTRACT's doc for why a raw return
// would crash `exec`'s uniform plain-JS exit. Carries the union of the operand(s)'
// own provenance.
const numberToStringFn = function (this: CallCtx, z: unknown, radix?: unknown): AString {
  const n = coerceNumeric(z, this.runCtx);
  const radixArg = radix === undefined ? undefined : coerceNumeric(radix, this.runCtx);
  const base = radixArg === undefined ? 10 : Number(radixArg.valueOf());
  let s: string;
  if (n instanceof AExact) {
    s = n.denom === 1 ? n.num.toString(base) : `${n.num.toString(base)}/${n.denom.toString(base)}`;
  } else {
    // Inexact mark preservation (R7RS § 6.2): `(number->string 5.0)` must stay "5.0".
    s = base === 10 ? n.toString() : n.real.toString(base);
  }
  // Same eager-accumulation gate as `applyNumeric` above.
  const provenance = isEagerAccumulationActive()
    ? unionProvenance(radixArg === undefined ? [n] : [n, radixArg])
    : EMPTY_PROVENANCE;
  return new AString(s, provenance);
};

// ════════════════════════════════════════════════════════════════════════════
// `NumSpec.in`/`inRest`/`out` are the real scheme-zod.ts schemas — `contractFromSpec`
// is a trivial projection, and `marshalCall` runs the SAME schema at call time: one
// vocabulary, not two.
//
// Two arguments that still matter (honored by `marshalCall`'s `decodeArg`/
// `encodeResult`):
//
//   Decode order (coerce THEN marshal). `applyNumeric` runs `coerceNumeric` on every
//   call arg FIRST — `marshalCall`'s per-arg decode only ever sees an ANumeric. This
//   is WHY `decodeArg`'s `z.schemeNumber` identity special-case is safe: `arg` is
//   guaranteed AExact/AInexact already, never a raw scheme value.
//
//   Bool identity passthrough (R8). `out: z.boolean` positions must NOT let
//   `encodeResult` mint the ABool — `applyNumeric`'s `mintVerdict` does that AFTER
//   `marshalCall` returns, boxing the UNION of the call's operand provenance (R8),
//   not a single result's. An ABool minted inside `marshalCall` would carry no
//   provenance and be silently discarded — `encodeResult`'s `z.boolean` special case
//   exists to not do that work twice.
// ════════════════════════════════════════════════════════════════════════════

/** Map a NumSpec's schemas to a real `symbol.native` Contract — 1-tuple output
 *  (the common case). `floor/`/`truncate/`'s 2-value output and the bespoke
 *  (non-NumSpec) ops below build their Contract by hand. */
function contractFromSpec(spec: NumSpec): Contract<VectorSpec, VectorSpec, RestSpec> {
  return { input: spec.in, inputRest: spec.inRest, output: [spec.out] };
}

// ════════════════════════════════════════════════════════════════════════════
// Per-op specs — named so a `symbols` entry builds its Contract
// (`contractFromSpec(spec)`) AND its impl (`nativeNumericOp(name, spec)`) from ONE
// shared object. Every `symbols` entry below is a LITERAL `symbol.native` call.
// ════════════════════════════════════════════════════════════════════════════

const addSpec: NumSpec = {
  in: [],
  inRest: z.schemeNumber,
  out: z.schemeNumber,
  fn: addFn,
  zeroArgIdentity: (_ctx) => new AExact(0),
};
const subSpec: NumSpec = { in: [z.schemeNumber], inRest: z.schemeNumber, out: z.schemeNumber, fn: subFn };
const mulSpec: NumSpec = {
  in: [],
  inRest: z.schemeNumber,
  out: z.schemeNumber,
  fn: mulFn,
  zeroArgIdentity: (_ctx) => new AExact(1),
};
const divSpec: NumSpec = { in: [z.schemeNumber], inRest: z.schemeNumber, out: z.schemeNumber, fn: divFn };
// `quotient` uses `z.schemeNumber` in/out, NOT `z.bigint`: it shares the same
// box-native `toIntegerPair` door every other integer-division op uses (bypasses the
// loose codecs entirely, same reasoning as `schemeAbs`/`schemeFloor`), so a type
// mismatch names the argument and expects an "integer", not a bigint-shaped message.
const quotientSpec: NumSpec = { in: [z.schemeNumber, z.schemeNumber], out: z.schemeNumber, fn: quotientFn };
const moduloSpec: NumSpec = { in: [z.schemeNumber, z.schemeNumber], out: z.schemeNumber, fn: moduloFn };
const floorQuotientSpec: NumSpec = { in: [z.schemeNumber, z.schemeNumber], out: z.schemeNumber, fn: floorQuotientFn };
const floorRemainderSpec: NumSpec = { in: [z.schemeNumber, z.schemeNumber], out: z.schemeNumber, fn: floorRemainderFn };
const truncateQuotientSpec: NumSpec = {
  in: [z.schemeNumber, z.schemeNumber],
  out: z.schemeNumber,
  fn: truncateQuotientFn,
};
const truncateRemainderSpec: NumSpec = {
  in: [z.schemeNumber, z.schemeNumber],
  out: z.schemeNumber,
  fn: truncateRemainderFn,
};
const numeratorSpec: NumSpec = { in: [z.schemeNumber], out: z.schemeNumber, fn: numeratorFn };
const denominatorSpec: NumSpec = { in: [z.schemeNumber], out: z.schemeNumber, fn: denominatorFn };
const squareSpec: NumSpec = { in: [z.schemeNumber], out: z.schemeNumber, fn: squareFn };
const makeRectangularSpec: NumSpec = {
  in: [z.looseNumber, z.looseNumber],
  out: z.schemeNumber,
  fn: (): ANumeric => complexDoor(),
};
const makePolarSpec: NumSpec = {
  in: [z.looseNumber, z.looseNumber],
  out: z.schemeNumber,
  fn: (): ANumeric => complexDoor(),
};
const realPartSpec: NumSpec = { in: [z.schemeNumber], out: z.schemeNumber, fn: (): ANumeric => complexDoor() };
const imagPartSpec: NumSpec = { in: [z.schemeNumber], out: z.schemeNumber, fn: (): ANumeric => complexDoor() };
const magnitudeSpec: NumSpec = { in: [z.schemeNumber], out: z.schemeNumber, fn: (): ANumeric => complexDoor() };
const angleSpec: NumSpec = { in: [z.schemeNumber], out: z.schemeNumber, fn: (): ANumeric => complexDoor() };
// abs/zero?/positive?/negative?/gcd/lcm/floor/ceiling/truncate/round are ALL
// box-native (`z.schemeNumber` in/out, `fn` operates on ANumeric directly) — none of
// them touch `z.looseNumber`/`z.looseAnyNumber` in OUTPUT position, which is precisely
// how they satisfy the encode-edge law (§2.2) without a generic `wantExact`-threading
// mechanism: encode never runs a shape-guessing codec on these because `fn`'s return is
// already the correctly (in)exact box. A future op that DOES need loose-number OUTPUT
// should follow this same pattern rather than reintroducing the shape-guessing bug.
const absSpec: NumSpec = { in: [z.schemeNumber], out: z.schemeNumber, fn: schemeAbs };
const gcdSpec: NumSpec = {
  in: [],
  inRest: z.schemeNumber,
  out: z.schemeNumber,
  fn: gcdFn,
  zeroArgIdentity: (_ctx) => new AExact(0),
};
const maxSpec: NumSpec = { in: [z.schemeNumber], inRest: z.schemeNumber, out: z.schemeNumber, fn: maxFn };
const minSpec: NumSpec = { in: [z.schemeNumber], inRest: z.schemeNumber, out: z.schemeNumber, fn: minFn };
const zeroSpec: NumSpec = { in: [z.schemeNumber], out: z.boolean, fn: isZeroFn };
const positiveSpec: NumSpec = { in: [z.schemeNumber], out: z.boolean, fn: isPositiveFn };
const negativeSpec: NumSpec = { in: [z.schemeNumber], out: z.boolean, fn: isNegativeFn };
// odd?/even? use `z.integer`, NOT `z.bigint`: `z.integer` decodes either
// AExact/AInexact to a safe-int `number` and doors on a non-integer/out-of-range
// operand with an "integer" message, matching R7RS's own domain for these two
// predicates.
const oddSpec: NumSpec = { in: [z.integer], out: z.boolean, fn: isOddFn };
const evenSpec: NumSpec = { in: [z.integer], out: z.boolean, fn: isEvenFn };
const floorSpec: NumSpec = { in: [z.schemeNumber], out: z.schemeNumber, fn: schemeFloor };
const ceilingSpec: NumSpec = { in: [z.schemeNumber], out: z.schemeNumber, fn: schemeCeiling };
const truncateSpec: NumSpec = { in: [z.schemeNumber], out: z.schemeNumber, fn: schemeTruncate };
const roundSpec: NumSpec = { in: [z.schemeNumber], out: z.schemeNumber, fn: schemeRound };
const sqrtSpec: NumSpec = { in: [z.schemeNumber], out: z.schemeNumber, fn: sqrtFn };
// Transcendentals: DECODE stays `z.looseNumber` (permissive — accepts +nan.0/+inf.0,
// lossily divides a non-integer exact rational; unaffected by the encode-edge bug,
// which is an ENCODE-direction issue). OUTPUT flips `z.looseNumber` → `z.inexact`
// (§2.2: "inexact-by-spec-class... mint wantExact=false silently") — `z.inexact`
// ALWAYS constructs AInexact, never re-derives exactness from the result's shape, so
// `(exact? (sin 0))` can't accidentally come back `#t` just because `Math.sin(0)`
// happens to be the safe integer `0`.
const expSpec: NumSpec = { in: [z.looseNumber], out: z.inexact, fn: Math.exp };
const logSpec: NumSpec = { in: [z.looseNumber], inRest: z.looseNumber, out: z.inexact, fn: logFn };
const sinSpec: NumSpec = { in: [z.looseNumber], out: z.inexact, fn: Math.sin };
const cosSpec: NumSpec = { in: [z.looseNumber], out: z.inexact, fn: Math.cos };
const tanSpec: NumSpec = { in: [z.looseNumber], out: z.inexact, fn: Math.tan };
const asinSpec: NumSpec = { in: [z.looseNumber], out: z.inexact, fn: Math.asin };
const acosSpec: NumSpec = { in: [z.looseNumber], out: z.inexact, fn: Math.acos };
const atanSpec: NumSpec = { in: [z.looseNumber], inRest: z.looseNumber, out: z.inexact, fn: atanFn };
const lcmSpec: NumSpec = {
  in: [],
  inRest: z.schemeNumber,
  out: z.schemeNumber,
  fn: lcmFn,
  zeroArgIdentity: (_ctx) => new AExact(1),
};

// ── Bespoke contracts — ops whose impl does NOT come from `nativeNumericOp`/`NumSpec`
// (own coercion + bespoke `marshalCall` wrapper, or no NumSpec), so their Contract is
// hand-declared to match the impl's OWN JS signature (input) and narrowest return type
// (output) — never a `NumSpec` borrowed from an unrelated helper. ─────────────────────

/** Type-predicate contracts — total boolean at runtime; dual type-guard harvest.
 *  Every scheme number (exact AND inexact) decodes to a plain JS `number` — there is
 *  no JS-side type that distinguishes "exact" from "inexact" (that distinction is a
 *  scheme-plane box-class fact, not a JS shape one), so `NUMBER_GUARD`/`EXACT_GUARD`
 *  both narrow to `number`, never `bigint`. */
const NUMBER_GUARD: Contract<VectorSpec, VectorSpec, RestSpec> = {
  input: [z.schemeValue],
  output: [z.boolean],
  type: dedent`
          {
            (x: unknown): x is number;
            <T>(x: T): x is Extract<T, number>;
          }
        `,
};
const EXACT_GUARD: Contract<VectorSpec, VectorSpec, RestSpec> = {
  input: [z.schemeValue],
  output: [z.boolean],
  type: dedent`
          {
            (x: unknown): x is number;
            <T>(x: T): x is Extract<T, number>;
          }
        `,
};
const INEXACT_GUARD: Contract<VectorSpec, VectorSpec, RestSpec> = {
  input: [z.schemeValue],
  output: [z.boolean],
  type: dedent`
          {
            (x: unknown): x is number;
            <T>(x: T): x is Extract<T, number>;
          }
        `,
};

const QUOTIENT_REMAINDER_PRODUCT_CONTRACT: Contract<VectorSpec, VectorSpec, RestSpec> = {
  input: [z.schemeNumber, z.schemeNumber],
  output: [z.pair],
};

/** exact-integer-sqrt → (s . r); one non-neg exact integer input. */
const EXACT_ISQRT_PRODUCT_CONTRACT: Contract<VectorSpec, VectorSpec, RestSpec> = {
  input: [z.schemeNumber],
  output: [z.pair],
};

const ONE_ARG_NUM_OUTPUT_CONTRACT: Contract<VectorSpec, VectorSpec, RestSpec> = {
  input: [z.schemeNumber],
  output: [z.schemeNumber],
};

/** `>>`/`<<` — `(a: unknown, b: unknown) => ANumeric`. `shiftRightFn`/`shiftLeftFn`
 *  `coerceNumeric` both operands before `marshalCall(arithmeticShiftSpec, …)` (which
 *  doors at runtime if not integer-shaped) — the wide `schemeNumber` is the honest
 *  declared domain; integer narrowing is `arithmeticShiftSpec`'s own runtime check. */
const TWO_ARG_NUM_OUTPUT_CONTRACT: Contract<VectorSpec, VectorSpec, RestSpec> = {
  input: [z.schemeNumber, z.schemeNumber],
  output: [z.schemeNumber],
};

/** `inexact`/`exact->inexact` — `(z: unknown) => AInexact` (narrower than the generic
 *  scheme-number union, matching `inexactFn`'s declared return). Input `z.schemeNumber`
 *  (`inexactFn` `coerceNumeric`s first). */
const INEXACT_CONTRACT: Contract<VectorSpec, VectorSpec, RestSpec> = {
  input: [z.schemeNumber],
  output: [z.inexact],
};

/** `exact`/`inexact->exact` — `(z: unknown) => AExact` (narrower than the generic
 *  scheme-number union, matching `exactFn`'s declared return). Input `z.schemeNumber`
 *  (`exactFn` `coerceNumeric`s first). */
const EXACT_CONTRACT: Contract<VectorSpec, VectorSpec, RestSpec> = {
  input: [z.schemeNumber],
  output: [z.exact],
};

/** `number->string` — `(z: unknown, radix?: unknown) => AString` (boxed, carrying the
 *  union of its operands' provenance — RULINGS.md R1: `exec`'s SIMPLE tier calls `toJS`
 *  on every result, which strict-doors a raw value; a bare-JS return would crash any
 *  top-level `(number->string …)` call). The `z.string` contract's DECODED type is still
 *  `string` (it names what the value represents, not the native's return shape). Both
 *  `z`/`radix` are `z.schemeNumber` — `numberToStringFn` `coerceNumeric`s each. */
const NUMBER_TO_STRING_CONTRACT: Contract<VectorSpec, VectorSpec, RestSpec> = {
  input: [z.schemeNumber, z.schemeNumber.optional()],
  output: [z.string],
};

// ════════════════════════════════════════════════════════════════════════════
// Contract.emit — + / - / * / / quotient / modulo / = / comparisons / zero?
// Residual-lite constructors from emit/. Law W (sync-shaped, never mint Await).
//
// + - * / quotient modulo = are unconditional (no argFacts branch): §7 one-number
// law fixes the algorithm per symbol. Comparisons and zero? are fact-gated (Law A).
// ════════════════════════════════════════════════════════════════════════════

/** Fixed-arity refusal: wrong arity → `ctx.door`, not a walker crash on undefined. */
function exactly<T>(ctx: EmitCtx<R>, sym: string, args: readonly T[], n: number): readonly T[] {
  if (args.length !== n) ctx.door(`\`${sym}\` wants exactly ${n} argument${n === 1 ? "" : "s"}, got ${args.length}`);
  return args;
}

// ── §7 one-number: + - * / — left folds, zero ctx reads ─────────────────────────────
// One JS number payload; left folds print flat (`a + b + c`).
const foldBin = (op: BinOp, args: readonly R[]): R => args.reduce((acc, a) => Bin(op, acc, a));

const plusEmitRule: EmitRule<R> = {
  // (+) → 0 (the additive identity); (+ x) → x itself — no operator node emitted.
  call: (args) => (args.length === 0 ? Lit(0) : foldBin("+", args)),
};

const timesEmitRule: EmitRule<R> = {
  call: (args) => (args.length === 0 ? Lit(1) : foldBin("*", args)),
};

const minusEmitRule: EmitRule<R> = {
  // R7RS `-` wants ≥ 1 argument; unary is negation.
  call: (args, ctx) =>
    args.length === 0
      ? ctx.door("`-` wants at least 1 argument")
      : args.length === 1
        ? Un("-", args[0]!)
        : foldBin("-", args),
};

const divideEmitRule: EmitRule<R> = {
  // `/` is plain JS division (§7 — the interpreter's exact-rational richness is
  // interpreter-plane; the artifact divides). Unary is the R7RS reciprocal: (/ x) → 1 / x.
  call: (args, ctx) =>
    args.length === 0
      ? ctx.door("`/` wants at least 1 argument")
      : args.length === 1
        ? Bin("/", Lit(1), args[0]!)
        : foldBin("/", args),
};

const quotientEmitRule: EmitRule<R> = {
  call: (args, ctx) => {
    const [a, b] = exactly(ctx, "quotient", args, 2);
    // Global Math via minted Binding — walker's frame pre-seeds Math/Error/Promise
    // so a user binding named Math disambiguates instead of shadowing.
    return Method(Ref(Binding("Math")), "trunc", [Bin("/", a!, b!)]);
  },
};

const moduloEmitRule: EmitRule<R> = {
  call: (args, ctx) => {
    const [a, n] = exactly(ctx, "modulo", args, 2);
    // JS `%` is a REMAINDER (sign-of-dividend); `((a % n) + n) % n` is the one
    // correct sign-of-divisor modulo algorithm over it (Appendix B).
    return Bin("%", Bin("+", Bin("%", a!, n!), n!), n!);
  },
};

const numEqEmitRule: EmitRule<R> = {
  call: (args) => {
    // R7RS: a 0/1-ary comparison is vacuously true (degenerate — a lowered operand
    // residual is discarded here; sound for the pure slice corpus).
    if (args.length < 2) return Lit(true);
    if (args.length === 2) return Bin("===", args[0]!, args[1]!);
    // n-ary: a === b && b === c — middle operands appear twice; §2.2 licenses pure
    // double-evaluation (a perf note, not a correctness bug; temps are effect-
    // discipline, not mutation-discipline). `(= 1 1.0)` → `1 === 1.0` → true, natively
    // correct under the one-number representation (Appendix B).
    let chain: R = Bin("===", args[0]!, args[1]!);
    for (let i = 2; i < args.length; i++) chain = Bin("&&", chain, Bin("===", args[i - 1]!, args[i]!));
    return chain;
  },
};

// ── §7 fact-gated: < <= > >= — Law A, argFacts-gated (unlike =/+/-/*//) ──────────────
// `=` is unconditional: looseCompare("=", numEqOp) has no FL-Ord fallback; nil is
// ===-comparable under §7. Relationals use wrapOrd — also dispatches non-numeric Ord
// (strings/chars/DateTime via tf(lte)) and nilOrderCompare (nil-as-bottom), neither
// of which JS's raw < <= > >= replicate. UNPROVEN operand may be nil or non-numeric
// Ord → bare JS operator wrong. ONLY when EVERY operand proves numeric (∀-over-union,
// nil-excluding) is the raw JS op the scheme numeric comparison. Else full runtime.
function compareEmitRule(sym: "<" | ">" | "<=" | ">="): EmitRule<R> {
  return {
    call: (args, ctx) => {
      // R7RS: 0/1-ary comparison is vacuously true.
      if (args.length < 2) return Lit(true);
      // ALL-OR-NOTHING over the whole call (middle ops appear twice — no split chain).
      const allNumeric = args.every((_, i) => ctx.argFacts[i]?.numeric === true);
      if (!allNumeric) return Call(ctx.runtime(sym), args);
      if (args.length === 2) return Bin(sym, args[0]!, args[1]!);
      let chain: R = Bin(sym, args[0]!, args[1]!);
      for (let i = 2; i < args.length; i++) chain = Bin("&&", chain, Bin(sym, args[i - 1]!, args[i]!));
      return chain;
    },
  };
}

const ltEmitRule = compareEmitRule("<");
const gtEmitRule = compareEmitRule(">");
const lteEmitRule = compareEmitRule("<=");
const gteEmitRule = compareEmitRule(">=");

// ── §7 fact-gated: zero? ────────────────────────────────────────────────────────────
// Same gate: unproven may be non-numeric (x === 0 is the wrong question) → shim's
// coerceNumeric+door. Proven numeric → `x === 0`.
const zeroEmitRule: EmitRule<R> = {
  call: (args, ctx) => {
    const [n] = exactly(ctx, "zero?", args, 1);
    return ctx.argFacts[0]?.numeric === true ? Bin("===", n!, Lit(0)) : Call(ctx.runtime("zero?"), [n!]);
  },
};

export default EnvCapability.define("scheme/numeric", {
  // `z` stays a module import here: this pack builds its `NumSpec` contract table and
  // `z.ZodTypeAny` type positions at module scope (the injected `z` param only exists
  // inside this callback), so only `symbol` needs injecting.
  symbols: (symbol) => ({
    // ── Arithmetic ──────────────────────────────────────────────────────────────
    "+": symbol.native`+: variadic sum (0 with no args)`(
      { ...contractFromSpec(addSpec), emit: plusEmitRule },
      nativeNumericOp("+", addSpec),
    ),
    "-": symbol.native`-: difference; unary negates`(
      { ...contractFromSpec(subSpec), emit: minusEmitRule },
      nativeNumericOp("-", subSpec),
    ),
    "*": symbol.native`*: variadic product (1 with no args)`(
      { ...contractFromSpec(mulSpec), emit: timesEmitRule },
      nativeNumericOp("*", mulSpec),
    ),
    "/": symbol.native`/: division; unary is reciprocal`(
      { ...contractFromSpec(divSpec), emit: divideEmitRule },
      nativeNumericOp("/", divSpec),
    ),
    quotient: symbol.native`quotient: integer quotient truncated toward zero`(
      { ...contractFromSpec(quotientSpec), emit: quotientEmitRule },
      nativeNumericOp("quotient", quotientSpec),
    ),
    remainder: symbol.native`remainder: remainder of truncating division`(contractFromSpec(remainderSpec), remainderOp),
    modulo: symbol.native`modulo: modulo (sign of divisor)`(
      { ...contractFromSpec(moduloSpec), emit: moduloEmitRule },
      nativeNumericOp("modulo", moduloSpec),
    ),
    "floor-quotient": symbol.native`floor-quotient: quotient toward negative infinity`(
      contractFromSpec(floorQuotientSpec),
      nativeNumericOp("floor-quotient", floorQuotientSpec),
    ),
    "floor-remainder": symbol.native`floor-remainder: remainder of floor division`(
      contractFromSpec(floorRemainderSpec),
      nativeNumericOp("floor-remainder", floorRemainderSpec),
    ),
    "truncate-quotient": symbol.native`truncate-quotient: quotient truncated toward zero`(
      contractFromSpec(truncateQuotientSpec),
      nativeNumericOp("truncate-quotient", truncateQuotientSpec),
    ),
    "truncate-remainder": symbol.native`truncate-remainder: remainder of truncating division`(
      contractFromSpec(truncateRemainderSpec),
      nativeNumericOp("truncate-remainder", truncateRemainderSpec),
    ),
    numerator: symbol.native`numerator: numerator of a rational`(
      contractFromSpec(numeratorSpec),
      nativeNumericOp("numerator", numeratorSpec),
    ),
    denominator: symbol.native`denominator: denominator of a rational`(
      contractFromSpec(denominatorSpec),
      nativeNumericOp("denominator", denominatorSpec),
    ),
    square: symbol.native`square: n * n`(contractFromSpec(squareSpec), nativeNumericOp("square", squareSpec)),
    "exact-integer-sqrt": symbol.native`exact-integer-sqrt: (s . r) with s² ≤ n < (s+1)² and n = s² + r`(
      EXACT_ISQRT_PRODUCT_CONTRACT,
      exactIntegerSqrtFn as (...args: unknown[]) => unknown,
    ),
    rationalize: symbol.native`rationalize: simplest rational within e of x`(
      TWO_ARG_NUM_OUTPUT_CONTRACT,
      rationalizeFn as (...args: unknown[]) => unknown,
    ),
    "make-rectangular": symbol.native`make-rectangular: DOORED (complex unsupported)`(
      contractFromSpec(makeRectangularSpec),
      nativeNumericOp("make-rectangular", makeRectangularSpec),
    ),
    "make-polar": symbol.native`make-polar: DOORED (complex unsupported)`(
      contractFromSpec(makePolarSpec),
      nativeNumericOp("make-polar", makePolarSpec),
    ),
    "real-part": symbol.native`real-part: DOORED (complex unsupported)`(
      contractFromSpec(realPartSpec),
      nativeNumericOp("real-part", realPartSpec),
    ),
    "imag-part": symbol.native`imag-part: DOORED (complex unsupported)`(
      contractFromSpec(imagPartSpec),
      nativeNumericOp("imag-part", imagPartSpec),
    ),
    magnitude: symbol.native`magnitude: DOORED (complex unsupported)`(
      contractFromSpec(magnitudeSpec),
      nativeNumericOp("magnitude", magnitudeSpec),
    ),
    angle: symbol.native`angle: DOORED (complex unsupported)`(
      contractFromSpec(angleSpec),
      nativeNumericOp("angle", angleSpec),
    ),
    abs: symbol.native`abs: absolute value`(contractFromSpec(absSpec), nativeNumericOp("abs", absSpec)),
    gcd: symbol.native`gcd: greatest common divisor (non-negative)`(
      contractFromSpec(gcdSpec),
      nativeNumericOp("gcd", gcdSpec),
    ),
    lcm: symbol.native`lcm: least common multiple (non-negative)`(
      contractFromSpec(lcmSpec),
      nativeNumericOp("lcm", lcmSpec),
    ),
    expt: symbol.native`expt: exponentiation`(contractFromSpec(exptSpec), exptOp),
    max: symbol.native`max: maximum (inexactness contagious)`(
      contractFromSpec(maxSpec),
      nativeNumericOp("max", maxSpec),
    ),
    min: symbol.native`min: minimum (inexactness contagious)`(
      contractFromSpec(minSpec),
      nativeNumericOp("min", minSpec),
    ),

    // ── Comparison (numeric core + FL-Ord fallback + nil-tolerant overlay) ────────
    "=": symbol.native`=: numeric equality (nil-tolerant)`(
      { ...contractFromSpec(numEqSpec), emit: numEqEmitRule },
      looseCompare("=", numEqOp),
    ),
    "<": symbol.native`<: strictly increasing (FL-Ord fallback, nil-tolerant)`(
      { ...contractFromSpec(ltSpec), emit: ltEmitRule },
      looseCompare("<", wrapOrd(ltOp, "<")),
    ),
    ">": symbol.native`>: strictly decreasing`(
      { ...contractFromSpec(gtSpec), emit: gtEmitRule },
      looseCompare(">", wrapOrd(gtOp, ">")),
    ),
    "<=": symbol.native`<=: non-decreasing`(
      { ...contractFromSpec(lteSpec), emit: lteEmitRule },
      looseCompare("<=", wrapOrd(lteOp, "<=")),
    ),
    ">=": symbol.native`>=: non-increasing`(
      { ...contractFromSpec(gteSpec), emit: gteEmitRule },
      looseCompare(">=", wrapOrd(gteOp, ">=")),
    ),

    // ── Sign / parity predicates (throwing — coerce then test) ───────────────────
    "zero?": symbol.native`zero?: #t iff n is zero`(
      { ...contractFromSpec(zeroSpec), emit: zeroEmitRule },
      nativeNumericOp("zero?", zeroSpec),
    ),
    "positive?": symbol.native`positive?: #t iff n > 0`(
      contractFromSpec(positiveSpec),
      nativeNumericOp("positive?", positiveSpec),
    ),
    "negative?": symbol.native`negative?: #t iff n < 0`(
      contractFromSpec(negativeSpec),
      nativeNumericOp("negative?", negativeSpec),
    ),
    "odd?": symbol.native`odd?: #t iff n is odd`(contractFromSpec(oddSpec), nativeNumericOp("odd?", oddSpec)),
    "even?": symbol.native`even?: #t iff n is even`(contractFromSpec(evenSpec), nativeNumericOp("even?", evenSpec)),

    // ── R7RS tower-type predicates (total — a non-number is #f, not an error) ─────
    // type: guards — real/rational/integer live in the number tower image; complex? is the omitted-tower stub.
    "complex?": symbol.native`complex?: always #f (complex tower omitted)`(
      NUMBER_GUARD,
      nativeTypePredicate("complex?", isComplex),
    ),
    "real?": symbol.native`real?: #t for any number (reals-only tower)`(
      NUMBER_GUARD,
      nativeTypePredicate("real?", (n) => n.isReal),
    ),
    "rational?": symbol.native`rational?: #t for finite reals`(
      NUMBER_GUARD,
      nativeTypePredicate("rational?", (n) => n.isRational),
    ),
    "integer?": symbol.native`integer?: #t for integer values (exact or inexact)`(
      NUMBER_GUARD,
      nativeTypePredicate("integer?", (n) => n.isInteger),
    ),
    "exact?": symbol.native`exact?: #t for exact numbers`(
      EXACT_GUARD,
      nativeTypePredicate("exact?", (n) => n.isExact),
    ),
    "inexact?": symbol.native`inexact?: #t for inexact numbers`(
      INEXACT_GUARD,
      nativeTypePredicate("inexact?", (n) => !n.isExact),
    ),
    "exact-integer?": symbol.native`exact-integer?: #t for exact integers`(
      EXACT_GUARD,
      nativeTypePredicate("exact-integer?", (n) => n.isExact && n.isInteger),
    ),
    // finite?/infinite?/nan? refine among numbers; harvest as number|bigint (same tower).
    "finite?": symbol.native`finite?: #t for finite numbers`(
      NUMBER_GUARD,
      nativeTypePredicate("finite?", (n) => n.isFinite),
    ),
    "infinite?": symbol.native`infinite?: #t for ±infinity`(
      INEXACT_GUARD, // ±inf are inexact only in our tower
      nativeTypePredicate("infinite?", (n) => !n.isFinite && !n.isNaN),
    ),
    "nan?": symbol.native`nan?: #t for NaN`(
      INEXACT_GUARD,
      nativeTypePredicate("nan?", (n) => n.isNaN),
    ),

    // ── Rounding ─────────────────────────────────────────────────────────────────
    floor: symbol.native`floor: largest integer ≤ n`(contractFromSpec(floorSpec), nativeNumericOp("floor", floorSpec)),
    ceiling: symbol.native`ceiling: smallest integer ≥ n`(
      contractFromSpec(ceilingSpec),
      nativeNumericOp("ceiling", ceilingSpec),
    ),
    truncate: symbol.native`truncate: integer toward zero`(
      contractFromSpec(truncateSpec),
      nativeNumericOp("truncate", truncateSpec),
    ),
    round: symbol.native`round: nearest integer, ties to even`(
      contractFromSpec(roundSpec),
      nativeNumericOp("round", roundSpec),
    ),

    // ── Transcendentals ──────────────────────────────────────────────────────────
    sqrt: symbol.native`sqrt: square root (exact for perfect squares)`(
      contractFromSpec(sqrtSpec),
      nativeNumericOp("sqrt", sqrtSpec),
    ),
    exp: symbol.native`exp: e raised to n`(contractFromSpec(expSpec), nativeNumericOp("exp", expSpec)),
    log: symbol.native`log: natural log, or log base`(contractFromSpec(logSpec), nativeNumericOp("log", logSpec)),
    sin: symbol.native`sin: sine (radians)`(contractFromSpec(sinSpec), nativeNumericOp("sin", sinSpec)),
    cos: symbol.native`cos: cosine (radians)`(contractFromSpec(cosSpec), nativeNumericOp("cos", cosSpec)),
    tan: symbol.native`tan: tangent (radians)`(contractFromSpec(tanSpec), nativeNumericOp("tan", tanSpec)),
    asin: symbol.native`asin: arc sine`(contractFromSpec(asinSpec), nativeNumericOp("asin", asinSpec)),
    acos: symbol.native`acos: arc cosine`(contractFromSpec(acosSpec), nativeNumericOp("acos", acosSpec)),
    atan: symbol.native`atan: arc tangent, or atan2`(contractFromSpec(atanSpec), nativeNumericOp("atan", atanSpec)),

    // ── Bitwise — DOORED (see the dragons note above) ─────────────────────────────
    "bitwise-and": symbol.notImplemented`bitwise-and: ${BITWISE_DOOR}`,
    "bitwise-ior": symbol.notImplemented`bitwise-ior: ${BITWISE_DOOR}`,
    "bitwise-xor": symbol.notImplemented`bitwise-xor: ${BITWISE_DOOR}`,
    "bitwise-not": symbol.notImplemented`bitwise-not: ${BITWISE_DOOR}`,
    "arithmetic-shift": symbol.notImplemented`arithmetic-shift: ${BITWISE_DOOR}`,

    // JS-shaped aliases (** % == | & ~ >> <<) live in scheme/sugarcoat — not R7RS.

    // ── Inline misc ops (own coercion + marshalled call; no provenance layer) ─────
    // Each impl below has a CONCRETE fixed-arity signature (unlike nativeNumericOp/
    // nativeTypePredicate's erased `(...args: unknown[]) => unknown`), so it doesn't
    // satisfy the loose `Contract<VectorSpec,VectorSpec,RestSpec>` without erasing the
    // arity first — same boundary as rosetta.ts/sequence.ts's `run` cross, cast once
    // per declaration.
    "floor/": symbol.native`floor/: floor quotient and remainder as pair (q . r)`(
      QUOTIENT_REMAINDER_PRODUCT_CONTRACT,
      floorSlashFn as (...args: unknown[]) => unknown,
    ),
    "truncate/": symbol.native`truncate/: truncate quotient and remainder as pair (q . r)`(
      QUOTIENT_REMAINDER_PRODUCT_CONTRACT,
      truncateSlashFn as (...args: unknown[]) => unknown,
    ),
    // R8 mint: boxes + forwards the operand's provenance (see nativeTypePredicate's doc
    // for why an unboxed native return is a P4 violation). Rest-param shape matches Impl's
    // variadic contract — no arity-erasing cast needed.
    "number?": symbol.native`number?: #t for any number`(
      NUMBER_GUARD,
      function (this: CallCtx, ...args: unknown[]): ABool {
        const [value] = args;
        return mintVerdict([value], isSchemeNumber(value));
      },
    ),
    "1+": symbol.native`1+: increment by one`(
      ONE_ARG_NUM_OUTPUT_CONTRACT,
      onePlusFn as (...args: unknown[]) => unknown,
    ),
    "1-": symbol.native`1-: decrement by one`(
      ONE_ARG_NUM_OUTPUT_CONTRACT,
      oneMinusFn as (...args: unknown[]) => unknown,
    ),
    inexact: symbol.native`inexact: exact→inexact conversion`(
      INEXACT_CONTRACT,
      inexactFn as (...args: unknown[]) => unknown,
    ),
    exact: symbol.native`exact: inexact→exact conversion`(EXACT_CONTRACT, exactFn as (...args: unknown[]) => unknown),
    "exact->inexact": symbol.native`exact->inexact: R5RS spelling of inexact`(
      INEXACT_CONTRACT,
      inexactFn as (...args: unknown[]) => unknown,
    ),
    "inexact->exact": symbol.native`inexact->exact: R5RS spelling of exact`(
      EXACT_CONTRACT,
      exactFn as (...args: unknown[]) => unknown,
    ),
    "number->string": symbol.native`number->string: format a number in a radix`(
      NUMBER_TO_STRING_CONTRACT,
      numberToStringFn as (...args: unknown[]) => unknown,
    ),
  }),
});
