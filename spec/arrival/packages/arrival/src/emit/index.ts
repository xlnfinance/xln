// emit — `@inhuman.tools/arrival/emit`: pure-data types a rule author writes against
// (`Contract.emit: EmitRule<R>`, residual builders `Bin`/`Call`/`Member`/…).
// Transitive closure of this barrel stays `typescript`-free so a Contract can carry emit
// rules without dragging the LanguageService into arrival core.
//
// LAYERING RULE (canonical; other emit/ files point here). Compiler package
// (arrival-mercury) READS contracts and interprets residuals; arrival core NEVER imports
// the compiler. Rejected: co-bundling these types with LanguageService machinery (the
// `type-layer` anti-pattern) forces all-or-nothing access and pulls `typescript` into
// every consumer.
//
// Residual algebra `R` is owned by the compiler; `EmitRule`/`EmitCtx` stay generic over
// an opaque residual (./emit-rule.ts). `residual-lite` is a local structural mirror of
// the residual builders (./residual-lite.ts).

export type { TypeFacts } from "./type-facts.js";
export type { EmitConfig, EmitCtx, EmitRule, RefPolicy } from "./emit-rule.js";

export type { R } from "./residual-lite.js";
// Binding is a merged type + value; this value re-export carries both facets.
export { ArrayLit, Arrow, Bin, Binding, Call, Index, Lit, Member, Method, Ref, Spread, Un } from "./residual-lite.js";
