// type-emit — the TYPE pass: emits virtual TypeScript (type-checked, never run).
// Non-narrowing conditions lower as `(expr !== false)` (Scheme truth); narrowing
// forms emit native boolean ops (see emit.ts).
export {
  emitTypes,
  type EmitTypesOptions,
  type EmitTypesResult,
  type Mapping,
  LIST_DOMAIN_REVERSERS,
  DEMAND_SOURCE_HEADS,
  DEMAND_OPAQUE_HEADS,
} from "./emit.js";
export {
  emitDataRequireFace,
  emitHbsRequireFace,
  emitRequireFaceModule,
  emitTypedRequireFace,
} from "./require-face.js";
export {
  decodeSchemeIdent,
  encodeSchemeIdent,
  isPlainIdent,
  schemeifyTsText,
  schemeIdentIsBareTs,
  SCHEME_IDENT_CHAR_TOKENS,
  SCHEME_IDENT_RESERVED,
  SCHEME_IDENT_TOKEN_CHARS,
} from "./scheme-ident.js";
