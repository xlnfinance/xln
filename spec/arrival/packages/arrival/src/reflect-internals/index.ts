// `@inhuman.tools/arrival/reflect-internals` — the value-CLASS reflection tier: every
// concrete `AValue` subclass + its singletons, the box/quote leaves, the offending-value
// teaching read, deep attestation, and numeric parsing. The `-internals` name is the
// no-stability-contract signal: a SIBLING CONTRACT between arrival core and packages that
// walk a parsed/evaluated tree by `instanceof` (arrival-serializer, mcp-substrate's
// statement-facts, arrival-provenance's verdict machinery, arrival-overridable-lens's
// crossing reads) — never the capability-authoring public surface
// (`EnvCapability`/`symbol`/`z`, the package root). Shape may change whenever the runtime
// value hierarchy does; no round-trip promise beyond "these are the real classes `exec`'s
// crossed values are instances of."

// Core value class — deliberately NOT `EMPTY_PROVENANCE`/`deepProvenance` (those stay
// root-level, part of the provenance-AS-DATA surface, not value reflection).
export { type AKind, AValue } from "../values/primitives/AValue.js";

// Booleans — both spellings (A* aliases for arrival-chain-style consumers; see AValue.ts
// for the no-subtype-imports reasoning).
export {
  ABool,
  schemeFalse as AFalse,
  schemeFalse,
  schemeTrue as ATrue,
  schemeTrue,
} from "../values/primitives/ABool.js";
export { ACharacter, characters } from "../values/primitives/ACharacter.js";
export { nil, ANil } from "../values/primitives/ANil.js";
export { theVoid, AVoid } from "../values/primitives/AVoid.js";
export { ASymbol } from "../values/primitives/ASymbol.js";
export { AString } from "../values/primitives/AString.js";
export { ABytevector } from "../values/primitives/ABytevector.js";
export { APair } from "../values/primitives/APair.js";
export { AVector } from "../values/primitives/AVector.js";
export { ADict, type DictLiteralNode } from "../values/primitives/ADict.js";
export { EOF } from "../values/primitives/EOF.js";

// Number system: AExact (rationals) and AInexact (floats/complex), plus the parser both
// root through (`parseNumber` in `values/numbers.js`; no `Number(str)` re-implementation).
export { AExact } from "../values/primitives/AExact.js";
export { AInexact } from "../values/primitives/AInexact.js";
export { type ANumeric, parseNumber } from "../values/numbers.js";

// Value-representation leaves — box/quote/patch_value (unbox-a-literal, quote a form,
// patch a boxed value's contents in place).
export { box, patch_value, quote } from "../values/values-repr.js";

// Collection-type-error teaching read: which value a take/map/vector-ref/reduce/car/…
// refused because it wasn't a collection. `ErrorClass` alongside it (classifiers type
// against it).
export { attachOffendingValue, offendingValueOf, OFFENDING_VALUE, type ErrorClass } from "../errors.js";

// Deep attestation — consumers are reflection/verdict code (e.g. arrival-provenance
// restoring signability after a derived-value compute), not manifold authoring. The
// manifold boundary's three reads (attest/isAttested/freshIfSingleton) live on
// `/attestation`.
export { attestDeep } from "../values/attestation.js";
