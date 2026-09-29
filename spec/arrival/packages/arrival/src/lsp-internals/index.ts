// `@inhuman.tools/arrival/lsp-internals` — the STATIC-analysis tier: everything an editor
// service (arrival-lsp, mcp-typescript-lsp) or a discovery/roster reader needs to lex,
// validate, and type a program WITHOUT evaluating it. The `-internals` name is the
// no-stability-contract signal — a sibling contract between arrival core and its
// editor-tooling packages, never the capability-authoring public surface.

// Reader lexer entry — `tokenize(source, true)` lifts source into meta-tokens off the
// real FSM lexer (so `#\(`, string literals, `#|…|#`, and quote prefixes count correctly).
export { tokenize } from "../reader/tokenize.js";

// Static validation pass — parsed forms × a sealed-chain vocabulary → the complete
// eslint-style Diagnostic list (never crash-on-first).
export { validateProgram, StaticValidationError, type Diagnostic } from "../static-validation/validate-program.js";
export { vocabularyFromChain, type ProgramVocabulary, type VocabularyEntry } from "../static-validation/vocabulary.js";

// Exec-phases products — phase 1 (parse) and phase 2.5 (pure resolution-soundness pass
// over a sealed chain).
export { parseProgram, validateAgainstResolution, type ParsedProgram } from "../eval/exec-phases.js";

// Rosetta-type registry side-table harvest seam — an editor derives its lens roster
// from `[...rosettaTypesOf(env)]`.
export { rosettaTypesOf } from "../env/env-registries.js";

// Capability-introspection reads: contract-view projection (`contractOf`) and the
// prelude/symbol-define serializers a type-lens's ambient scheme vocabulary walks —
// the actually-assembled capability set, never a hand-picked subset.
export { contractOf, collectPrelude, collectSymbolDefines } from "../common/capability-internals.js";

// Runtime always folds BASE_ROSTER into every session (`execStateViaVocabulary`).
// The type lens must walk the same set — otherwise polyglot defines (`str`,
// `get-in`, …) resolve at run and free-name in the editor.
export { BASE_ROSTER } from "../env/base-roster.js";

// Type-layer: the Σ∩T narrow's flatten (so a hand-rolled `declare const` prints
// identically to a harvested signature), the diagnose lens, and the harvested-prelude
// assembly-from-signatures path (also reachable via `/type-layer` — additive, granular).
export { sTagToTsType } from "../type-layer/schema-to-ts.js";
export { harvestPlaneHost, type HarvestedPlaneHost } from "../type-layer/harvest-plane-host.js";
export { createDiagnoseLens, type DiagnoseLens, type RawMappedDiagnostic } from "../type-layer/diagnose.js";
export { assemblePreludeFromSignatures, type HarvestedPrelude } from "../type-layer/prelude.js";

// Oracle doors — the constraint-kernel oracle's Layer-S structural reader
// (sift/docs/CONSTRAINT-KERNEL-SPEC.md).
export { scan, type ScanResult } from "../oracle/scanner.js";
export { makeOracle } from "../oracle/index.js";
export type {
  CursorPosition,
  EvalResult,
  FormKind,
  OracleEnv,
  OracleScanner,
  OracleSession,
  OracleState,
  TokenClass,
  TypeTag,
} from "../oracle/contract.js";
