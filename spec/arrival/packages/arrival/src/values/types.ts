/**
 * Core Scheme value-type contracts.
 * Concrete value classes live in ./primitives/*; this file keeps the pure
 * type/interface/guard surface they share.
 *
 * SchemeValue is the honest union of every value the interpreter can hold:
 * every concrete AValue subclass, the live non-AValue orphan R7RSError,
 * and ACallable values. Excludes reader-internal sentinels (DatumReference,
 * EOF). Bare host functions are not SchemeValue members.
 */
import type { AExact } from "./primitives/AExact.js";
import type { AInexact } from "./primitives/AInexact.js";
import type { APair } from "./primitives/APair.js";
import type { ANil } from "./primitives/ANil.js";
import type { AString } from "./primitives/AString.js";
import type { ASymbol } from "./primitives/ASymbol.js";
import type { ABool } from "./primitives/ABool.js";
import type { AVector } from "./primitives/AVector.js";
import type { ABytevector } from "./primitives/ABytevector.js";
import type { ACharacter } from "./primitives/ACharacter.js";
import type { AVoid } from "./primitives/AVoid.js";
import type { AJSArray } from "../membrane/AJSArray.js";
import type { AJSObject } from "../membrane/AJSObject.js";
import type { ADict } from "./primitives/ADict.js";
import type { AOpaqueHandle } from "./primitives/AOpaqueHandle.js";
import type { EOF } from "./primitives/EOF.js";
import type { AKernelKeyword } from "./AKernelKeyword.js";
// R7RS error object — `error-object?` is `obj instanceof R7RSError`.
// `import type` keeps the mutual edge with errors.ts compile-time only.
import type { R7RSError } from "../errors.js";
import type { ACallable } from "./primitives/ACallable.js";
import type { ARosettaProcedure } from "./primitives/ARosettaProcedure.js";
import { AValue } from "./primitives/AValue.js";
import type { IsAny } from "../types/utility.js";

/**
 * Opaque bounce-marker for the trampoline. Real `Bounce` lives in eval/evaluator.ts;
 * the value channel only needs the brand. Call boundary narrows it out before any value use.
 */
export interface SchemeBounceMarker {
  readonly __bounce: true;
}

// `[T] extends [...]` (tuple-wrapped) on purpose: a naked `T extends ...` conditional
// DISTRIBUTES over the ~23-member SchemeValue union, exploding into shapes that unify
// with no open generic (and trips TS2589 in deep spines).
//
// Maximal-T short-circuit (`[SchemeValue] extends [T]`): when T is the whole union,
// recursive cdr constraint adds no information but makes the alias narrower than
// `APair<SchemeValue, SchemeValue> | ANil` — collapse default to that honest spine.
type AArrayListAlike<T extends SchemeValue> = [SchemeValue] extends [T]
  ? APair<SchemeValue, SchemeValue> | ANil
  : APair<T, [T] extends [APair<any, any> | ANil] ? T : AArrayListAlike<T>> | ANil;
type ATupleListAlike<T extends [...SchemeValue[]]> = T extends [
  infer Car extends SchemeValue,
  ...infer Cdr extends SchemeValue[],
]
  ? APair<Car, ATupleListAlike<Cdr>>
  : ANil;

export type AListAlike<T extends SchemeValue | [...SchemeValue[]] = SchemeValue> = [T] extends [[...SchemeValue[]]]
  ? ATupleListAlike<T>
  : [T] extends [SchemeValue]
    ? AArrayListAlike<T>
    : never;

export type AListAlikeValue<T extends AListAlike> = T extends AListAlike<infer V> ? V : never;
export type APairAsListValue<Car extends SchemeValue, Cdr extends SchemeValue> =
  | Car
  | (Cdr extends AListAlike ? AListAlikeValue<Cdr> : never);

export type SchemeValue =
  | AExact
  | AInexact
  | APair<any, any>
  | ANil
  | AString
  | ASymbol
  | ABool
  | AVector
  | ABytevector
  | ACharacter
  | AVoid
  | AJSArray
  | AJSObject
  | ADict
  | AOpaqueHandle
  | AKernelKeyword
  | R7RSError
  // ACallable: ALambda / ANativeProcedure / ARosettaProcedure / DoorProcedure.
  // `import type` keeps the edge compile-time only.
  | ACallable;

// ── AWrap / AUnwrap — honest jsToScheme/toJS membrane types (rosetta.ts).
// Same tuple-wrapped conditional discipline as AListAlike. Both directions
// short-circuit on the WIDEST possible input first (unknown / SchemeValue).

// ── JSWorldValue / JSWorldArray — JS side of the membrane AT THE TYPE LEVEL.
//
// HYGIENE LAW (docs/membrane.md §HYGIENE): a borrowed store holds JS-world values only.
// Stated as a type so every violator fails at tsc. Limit is honest: bare `unknown[]`
// still passes; what fails is a caller that statically knows it holds scheme values
// and buries them in a JS store. Penetration-point invariant is AJSArray.boxElement.

/** `never` iff T is known to carry a boxed scheme value; T otherwise. */
export type JSWorldValue<T> = IsAny<T> extends true ? T : [Extract<T, AValue>] extends [never] ? T : never;

/** Store that may back a borrowed container: element type carries no boxed scheme value.
 *  `SchemeValue[]` / `AValue[]` collapse to `never` — those are the real violators. */
export type JSWorldArray<T extends readonly unknown[]> =
  IsAny<T[number]> extends true ? T : [Extract<T[number], AValue>] extends [never] ? T : never;

/**
 * `jsToScheme<T>` return type — mirrors INBOUND_CLAIMS arm-for-arm (rosetta.ts).
 * A new claim in one must gain the other (P3).
 */
export type AWrap<T> = [unknown] extends [T]
  ? SchemeValue
  : [T] extends [AValue]
    ? T
    : [T] extends [null]
      ? ANil
      : [T] extends [undefined]
        ? AVoid
        : [T] extends [boolean]
          ? ABool
          : [T] extends [bigint]
            ? never // host bigint DOORS (NoLensError) — convert in safe range first
            : [T] extends [number]
              ? AExact | AInexact
              : [T] extends [string]
                ? AString
                : [T] extends [EOF | R7RSError]
                  ? T
                  : [T] extends [Uint8Array | ArrayBuffer | DataView]
                    ? T // binary FFI passthrough — never boxed, identity
                    : [T] extends [Promise<unknown>]
                      ? never // bare Promise DOORS — settle first
                      : [T] extends [readonly unknown[]]
                        ? AJSArray
                        : [T] extends [symbol]
                          ? ASymbol
                          : [T] extends [Function]
                            ? ARosettaProcedure // reverse-membrane lens — see hostFnToCallable
                            : [T] extends [object]
                              ? AJSObject
                              : SchemeValue;

/**
 * `toJS<T>` return type — mirrors each box's `arrival/toJS` protocol term.
 */
export type AUnwrap<T extends SchemeValue> = [SchemeValue] extends [T]
  ? unknown
  : [T] extends [ABool]
    ? boolean
    : [T] extends [AExact]
      ? number // safe-int by construction; egress divides (toJS(1/3) = 0.333…), never bigint
      : [T] extends [AInexact]
        ? number
        : [T] extends [AString]
          ? string
          : [T] extends [ACharacter]
            ? string
            : [T] extends [ANil]
              ? null
              : [T] extends [AVoid]
                ? undefined
                : [T] extends [AVector<infer E extends SchemeValue>]
                  ? AUnwrap<E>[]
                  : [T] extends [APair<any, any>]
                    ? unknown[] // one-way list→array projection — never recursive element type
                    : [T] extends [ADict]
                      ? Record<string, unknown>
                      : [T] extends [AJSArray]
                        ? readonly unknown[]
                        : [T] extends [AJSObject]
                          ? object
                          : [T] extends [ACallable]
                            ? (...args: unknown[]) => Promise<unknown>
                            : unknown;

export interface SchemeStringLike {
  __string__: string | string[];
  valueOf(): string;
  toString(): string;
}

export function isSchemeString(x: unknown): x is SchemeStringLike {
  return typeof x === "object" && x !== null && "__string__" in x;
}

export function isString(x: unknown): x is SchemeStringLike | string {
  return typeof x === "string" || isSchemeString(x);
}

// AList: "APair | ANil" spine. Deliberately NOT recursive — APair's method shapes are
// already self-referential through Cdr; a second alias-recursion layer risks TS2589.
// Car/Cdr default to `any`; `extends SchemeValue` bound is load-bearing (APair's own constraint).
export type AList<Car extends SchemeValue = any, Cdr extends Car extends ANil ? ANil : SchemeValue = any> =
  | APair<Car, Cdr>
  | ANil;

// ── Egress projection modes + membrane element exit ──
// ONE crossing protocol `arrival/toJS(exit?)`: no exit = serialization, exit present = membrane.

/** Egress modes. `bare` = serialization (callables stringify). `mem` = membrane crossing.
 *  Host bigint is a NoLensError door, not a projection choice. Adding a FUTURE
 *  projection-affecting RosettaOptions field REQUIRES a new member here —
 *  rosetta.ts's `_modeKeyExhaustive` makes forgetting a compile error. */
export type EgressMode = "bare" | "mem";
export const BARE_MODE: EgressMode = "bare";

/** Region wrapper cache's inner key — NOT EgressMode: `"typed"` is scheme-zod's
 *  z.procedure family; `"bare"` never mints wrappers. Live domain: {"mem","typed"}. */
export type WrapperKey = EgressMode | "typed";

/**
 * Membrane element exit, handed to any `arrival/toJS(exit?)` implementor.
 * Built exclusively by rosetta.ts's `egressAValue`; egress-proxy consumes the container half.
 */
export interface MembraneExit {
  /** Full recursive membrane crossing for one element, under the PINNED exporting region scope. */
  element(el: unknown): unknown;
  /** Branded cache-mode discriminator — derived from options CONTENT. Never `"bare"` in practice. */
  modeKey: EgressMode;
  /** Pinned scope's own membrane-proxy cache. Membrane proxy identity = (box, mode, SCOPE). */
  cache: WeakMap<AValue, Map<EgressMode, object>>;
}
