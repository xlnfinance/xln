/**
 * attestation — branded-value registry behind the manifold's `s/*` family
 * (design: arrival-manifold/docs/attestation-design.md).
 *
 * PROVENANCE/TAINT-FLOW, NOT TYPING — and deliberately not the provenance set.
 * Provenance has union/forward algebra (survives computation via
 * `withInputProvenance`); attestation needs DROP-ON-COMPUTE algebra: a computed
 * value must lose its inputs' attestation so a model re-asserts what the new
 * value IS. An identity-keyed WeakSet expresses that natively: every builtin
 * mints fresh boxes, so computation drops attestation for free, while
 * reference-passing preserves it for free.
 *
 * Three stamp sites:
 *   1. `bakeRosetta` return walk — source rosetta returns deep-attested;
 *   2. pluck inheritance — `ADict.get` / `AJSObject.get` / `AJSArray` elements
 *      attest boxes iff the container is attested;
 *   3. manifold `s/*` validators — explicit model-authored assertion.
 *
 * Enforcement lives in arrival-manifold's tool boundary; core only carries the
 * registry + stamps.
 */

import { AValue } from "./primitives/AValue.js";
import { schemeFalse, schemeTrue } from "./primitives/ABool.js";
import { ANil } from "./primitives/ANil.js";
import { AVoid } from "./primitives/AVoid.js";
import { ASymbol } from "./primitives/ASymbol.js";
import { APair } from "./primitives/APair.js";
import { AVector } from "./primitives/AVector.js";
import type { SchemeValue } from "./types.js";

const attested = new WeakSet<AValue>();

/** Shared-box families that must NEVER enter the registry:
 *  - ANil / AVoid — absent/unspecified; stamping shared nil would attest every missing field;
 *  - ASymbol — keywords are call syntax, never payload; per-run intern shares them;
 *  - schemeTrue/schemeFalse flyweights — attest a FRESH clone instead (`freshIfSingleton`). */
function refusesAttestation(v: AValue): boolean {
  return v instanceof ANil || v instanceof AVoid || v instanceof ASymbol || v === schemeTrue || v === schemeFalse;
}

/** Mark one value as attested. No-op on non-AValues and refused shared-box families. */
export function attest<V>(v: V): V {
  if (v instanceof AValue && !refusesAttestation(v)) attested.add(v);
  return v;
}

/** Is this exact box attested? `false` for anything that is not an AValue. */
export function isAttested(v: unknown): v is SchemeValue {
  return v instanceof AValue && attested.has(v);
}

/** Boolean escape hatch: shared flyweights clone so the CLONE can be attested without
 *  every `#t` in the program becoming attested. Everything else passes through. */
export function freshIfSingleton(v: SchemeValue): SchemeValue;
export function freshIfSingleton(v: unknown): unknown;
export function freshIfSingleton(v: unknown): unknown {
  if (v === schemeTrue) return schemeTrue.withProvenance(schemeTrue.provenance);
  if (v === schemeFalse) return schemeFalse.withProvenance(schemeFalse.provenance);
  return v;
}

function walk(v: unknown, seen: Set<unknown>): void {
  if (!(v instanceof AValue) || seen.has(v)) return;
  seen.add(v);
  attest(v);
  if (v instanceof APair) {
    walk(v.car, seen);
    walk(v.cdr, seen);
    return;
  }
  if (v instanceof AVector) {
    for (const el of v.__vector__) walk(el, seen);
  }
  // AJSObject / AJSArray: attest WRAPPER only — entries box lazily and inherit at pluck.
}

/** Deep-attest: container spine + every leaf. Lazy membrane wrappers attested shallowly.
 *  Cycle-safe. Twin of jsToScheme's provenance deep-stamp. */
export function attestDeep<V>(v: V): V {
  walk(v, new Set());
  return v;
}
