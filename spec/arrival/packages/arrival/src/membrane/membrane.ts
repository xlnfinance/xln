/**
 * Membrane — typed boundary crossing for Scheme ↔ JS interop.
 *
 * Inbound is `jsToScheme` (rosetta.ts). Outbound is `toJS` (same file). Member access
 * (`@`/`@?`/`@keys`, `:key`) lives on the values (`arrival/tagless-final/get|has|keys`);
 * the membrane has no member-read face. This module is the already-scheme door.
 *
 * Lineage: object-capability membranes (Miller 2006; Van Cutsem & Miller 2013).
 * Member-read protocol mirrors GraalVM Truffle InteropLibrary — see interop-access.ts.
 * Full map: `docs/membrane.md`.
 *
 * VALUE-IMPORTS `env/AmbientRuntime.ts` (hermeticity audit D4, `docs/strata.md` §2's
 * `membrane → env` edge): `AmbientRuntime`/`isAmbientRuntime` join `BoxedSchemeValue`
 * and `isSchemeValue` because an env is a CONTROL form the membrane must recognize
 * as already-scheme (a host function can bind INTO an env).
 */

import { AValue } from "../values/primitives/AValue.js";
import { ABool } from "../values/primitives/ABool.js";
import { ABytevector } from "../values/primitives/ABytevector.js";
import { AVector } from "../values/primitives/AVector.js";
import { AmbientRuntime, isAmbientRuntime } from "../env/AmbientRuntime.js";
import { LambdaContext } from "../eval/LambdaContext.js";
import { AString } from "../values/primitives/AString.js";
import { ASymbol } from "../values/primitives/ASymbol.js";
import { Macro } from "../eval/Macro.js";
import { AExact } from "../values/primitives/AExact.js";
import { AInexact } from "../values/primitives/AInexact.js";
import { APair } from "../values/primitives/APair.js";
import { AOpaqueHandle } from "../values/primitives/AOpaqueHandle.js";
import { Syntax } from "../eval/Syntax.js";
import { type ACallable } from "../values/primitives/ACallable.js";
import { ANil } from "../values/primitives/ANil.js";
import { AKernelKeyword } from "../values/AKernelKeyword.js";
import { AJSArray } from "./AJSArray.js";
import { AJSObject } from "./AJSObject.js";
import { ADict } from "../values/primitives/ADict.js";
import { ACharacter } from "../values/primitives/ACharacter.js";

/**
 * Closed union of "already scheme, don't re-wrap": every wrapper class, native scheme
 * type, special-form head (Macro/Syntax/AKernelKeyword), env, promise, and bare
 * Function (env may still bind a host function into value space). SUPERSET of
 * value-intent SchemeValue — the JS→Scheme boundary admits CONTROL forms that are
 * never values (Macro/Syntax/LambdaContext/AmbientRuntime, bare Function). That is
 * why BoxedSchemeValue isn't assignable to SchemeValue, and why the membrane keeps
 * its own boundary type. Scheme lambdas are real ALambda, caught by instanceof AValue.
 */
export type BoxedSchemeValue =
  | ANil
  | AJSObject
  | AJSArray
  | ADict
  | APair<any, any>
  | ASymbol
  | AString
  | ABytevector
  | AVector
  | ACharacter
  | AExact
  | AInexact
  | ABool
  | AOpaqueHandle
  | Macro
  | Syntax
  | LambdaContext
  | AmbientRuntime
  | AKernelKeyword
  | ACallable
  | Function;

/**
 * Already-scheme door. `instanceof AValue`, not `=== nil` — `nil.withProvenance`
 * mints fresh Nil clones; reference-equality would miss provenance-bearing list
 * terminators. RULINGS.md R3.
 */
export function isSchemeValue(value: unknown): value is BoxedSchemeValue {
  if (value instanceof AValue) return true;
  return value instanceof Macro || value instanceof Syntax || value instanceof LambdaContext || isAmbientRuntime(value);
}

/** Bytevector-like binary — pass through unwrapped; polymorphic bytevector ops accept them. */
export function isBytevectorLike(value: unknown): value is Uint8Array | ArrayBuffer | DataView {
  return (
    value instanceof Uint8Array ||
    value instanceof ArrayBuffer ||
    value instanceof DataView ||
    (typeof Buffer !== "undefined" && value instanceof Buffer)
  );
}

// Polyglot member access lives ON the values (tagless algebra):
// arrival/tagless-final/get|has|keys — ADict structurally, AJSObject/AJSArray through
// the interop read policy over their borrowed source. Membrane has no member-read face;
// env/polyglot verbs normalize the key and invoke the value terms directly.
