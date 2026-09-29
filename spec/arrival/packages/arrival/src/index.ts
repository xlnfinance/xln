// `@inhuman.tools/arrival` — the package root. TWO TIERS:
//
//   1. THIS BARREL is the PUBLIC surface — small on purpose, closed to three concerns:
//        • EVAL — `exec`/`execState`/`parse` + options/state, scope continuity
//          (`LexicalScope`/`SessionScope`), run identity (`RunContext`/`disposeRunContext`),
//          and the membrane crossing (`toJS`/`jsToScheme`/`ANil`).
//        • CAPABILITY AUTHORING — `EnvCapability`/`symbol`/`z`/`SymbolDeclaration`/
//          `RosettaSymbolDef` — the one contract every palette pack (and every external
//          capability author) declares against.
//        • PROVENANCE AS DATA — `EvalTap`/`deepProvenance`/`EMPTY_PROVENANCE`: readings are
//          data (plain records + a tap subscription), never a class hierarchy or an analysis
//          function — see the arrival design theorem.
//        Plus `ArrivalError`/`SchemeValue`/`Invocation` — the error root and the two
//        structural types a capability author's own signatures need to name.
//
//   2. `*-internals` SUBPATHS are SIBLING CONTRACTS, not this tier — the `-internals` NAME
//      is the no-stability-contract signal: `/reflect-internals` (value-class hierarchy),
//      `/lsp-internals` (static analysis), `/host-internals` (run observability, mid-run
//      assembly kernel, structural `SchemeEnv`, interop sealing). Each may change shape
//      whenever the machinery behind it does; importing one is an explicit "I depend on
//      arrival's internals" declaration.
//
// No eager bootstrap: importing this package fires no assembly. The self-hosted
// `Vocabulary` (env/vocabulary.ts) is built lazily, per capability-set tuple, memoized.

// ── EVAL ─────────────────────────────────────────────────────────────────────────────────────
// Generator-based evaluator: flat trampoline for stack safety. `exec`/`parse`/`execState`
// are the canonical stack-safe, budget-bounded path.
export { exec, execExpr, parse, execState, type ExecState } from "./eval/generator-exec.js";
export { type ExecOptions } from "./eval/generator-exec.js";

// Lexical-binding scope handle for `exec({ scope })` — hold a `LexicalScope.for(env)`
// across calls for REPL-style multi-step define accumulation. `SessionScope` is the
// refinement `LexicalScope.fresh()` mints (root frame carries the structural `SchemeEnv`
// write contract) — session products name it (arrival-run's `ArrivalSession.scope`,
// chain-env's `ChainEnv`).
export { LexicalScope, type SessionScope } from "./eval/LexicalScope.js";

// Run identity: `CONSTANT_CTX` and the run cache/effect-log/read-guard
// families live on `/host-internals` (host-integration machinery). `RunContext` and its
// teardown door stay here — `exec({ runCtx })` reuse is an eval concern every host needs.
export { RunContext, type MembraneClosure } from "./run/RunContext.js";
export { disposeRunContext } from "./run/run-lifecycle.js";

// Membrane crossing — `exec`'s return values are already crossed (via `toJS`); these
// are for a host building its own JS↔Scheme bridge around a run (handing a JS value
// into `{ scope }` accumulation, or reading a boxed COMPLEX-tier value by hand).
//
// Public outbound exit: `toJS` — dispatches each box's `arrival/toJS` protocol (P7).
// Inbound twin: `jsToScheme`. Worlds do not mix: scheme-side values cross with `toJS`
// once; JS-side values (e.g. `exec` results) never re-cross. `isSchemeValue` is a
// membrane predicate for double-wrap prevention / codec gates — not a soft peel.
export { isSchemeValue } from "./membrane/membrane.js";
export { toJS, jsToScheme } from "./membrane/rosetta.js";
// Membrane null/absent leaf — crosses both ways, so it travels with the eval surface
// rather than the value-class reflection tier (`/reflect-internals`).
export { ANil } from "./values/primitives/ANil.js";

// ── CAPABILITY AUTHORING ─────────────────────────────────────────────────────────────────────
// `EnvCapability` — the capability class (`exec({ capabilities })` roots). `symbol` — the
// typed-symbol factory ({ native, rosetta, tagless, … }). `z` — the scheme-zod codec
// namespace, namespaced (not `export *`) so `z.symbol` (codec) stays distinct from the
// top-level `symbol` (factory). Contract/CallCtx vocabulary for impl signatures and
// tooling. Opt-in packs (overridable / schema / loader) live under `./capabilities`.
export { EnvCapability } from "./common/capability.js";
export { symbol } from "./symbol/index.js";
export type {
  VectorSpec,
  RestSpec,
  Contract,
  ProvenanceRole,
  CacheClass,
  DoorSymbolDef,
  AEntity,
  RosettaSymbolDef,
} from "./common/symbols/_bake.js";
export type { CallCtx } from "./run/CallCtx.js";
// TIER RULE (hermeticity audit E3): a symbol earns the public tier over `/host-internals`
// only when a real consumer constructs it from outside this package — not because it is
// "dispatch machinery" or "the one construction site" in the abstract. `testCallCtx` is
// exactly that case: `arrival-mcp`'s tool-factory tests (`packages/arrival-mcp/src/__tests__/
// tool-factories.test.ts`) import it from `@inhuman.tools/arrival` (the root, not
// `/host-internals`) to drive a bare `fire(def, testCallCtx(), …)` call outside a real run.
// Demoting it would break that consumer; `makeCallCtx` ships alongside it rather than
// splitting one construction pair across two tiers. Every OTHER dispatch-machinery symbol
// stays on `/host-internals` by default — this pair is the named exception, not the
// precedent.
export { makeCallCtx, testCallCtx } from "./run/CallCtx.js";
export { withContractFields } from "./common/symbols/_bake.js";
export type { SymbolDeclaration } from "./common/capability.js";
export * as z from "./common/scheme-zod/index.js";

// ── PROVENANCE AS DATA ───────────────────────────────────────────────────────────────────────
export { type EvalTap } from "./eval/evaluator.js";
// Deep provenance of a value — the union of `.provenance` over every reachable `AValue`
// (pair spine, vector, JS array elements). Containers are provenance-transparent, so this
// is THE read for "which points fed this packed value".
export { deepProvenance } from "./provenance/deep-provenance.js";
export { EMPTY_PROVENANCE } from "./values/primitives/AValue.js";

// ── STRUCTURAL TYPES A CAPABILITY AUTHOR NAMES DIRECTLY ─────────────────────────────────────
// `SchemeValue` — honest union of every value the interpreter can hold; capability
// authors (and AST-walking consumers) name this directly rather than reaching into
// `/reflect-internals`.
export type { SchemeValue } from "./values/types.js";
// `Invocation` lives in `eval/dynamic-call-site.ts` so `rosetta.ts` can install one
// without importing the evaluator.
export type { Invocation } from "./eval/dynamic-call-site.js";

// Error root — every arrival error extends `ArrivalError`. `ErrorClass` (the
// `"arrival/error-category"` union every subclass must declare) is a cross-package type
// import for subclasses defined outside this package (e.g. arrival-provenance).
// `formatRunError` renders scheme stack + require chain for host run-error surfaces.
export { ArrivalError, formatRunError, type ErrorClass } from "./errors.js";
