// @inhuman.tools/arrival-types-bridge — the type-lens Scheme→virtual-TS emitter
// plus the parse/desugar/scope front it runs on. Consumed by arrival-lsp /
// arrival-codemirror (MIT) and re-exported by arrival-mercury (the run compiler).
export {
  emitTypes,
  type EmitTypesOptions,
  type EmitTypesResult,
  type Mapping,
  LIST_DOMAIN_REVERSERS,
  DEMAND_SOURCE_HEADS,
  DEMAND_OPAQUE_HEADS,
  emitDataRequireFace,
  emitHbsRequireFace,
  emitRequireFaceModule,
  emitTypedRequireFace,
  decodeSchemeIdent,
  encodeSchemeIdent,
  isPlainIdent,
  schemeifyTsText,
  schemeIdentIsBareTs,
  SCHEME_IDENT_CHAR_TOKENS,
  SCHEME_IDENT_RESERVED,
  SCHEME_IDENT_TOKEN_CHARS,
} from "./type-emit/index.js";
