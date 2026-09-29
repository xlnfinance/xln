// emit/emit-rule — EmitRule/EmitCtx/EmitConfig: pure-data rule surface a Contract may
// carry (`Contract.emit`). Layering rule (typescript-free) lives in ./index.ts.
//
// GENERIC OVER THE RESIDUAL. Both interfaces default `R = unknown`: bare `EmitRule` (as
// `Contract.emit` stores it) is fully opaque; rule-authoring sites instantiate
// `EmitRule<R>` against the real residual. Method (not property) signatures are
// deliberate — TS checks method parameters bivariantly, so a rule authored against real
// `R` stays assignable to the opaque `EmitRule` a Contract stores.

import type { TypeFacts } from "./type-facts.js";

/** Value-position behavior for a symbol used as a VALUE (`(map car xss)`), not applied.
 *  - `"shim"` (DEFAULT): emit `RuntimeRef(sym)` — always a correct function value.
 *  - `"eta"`: opt-in for fact-driven-or-structural rules (car, cdr, accessors,
 *    predicates) — eta-expansion of `call` against the instantiated use-site signature
 *    (`TypeFacts.callable`); no instantiated signature ⇒ shim (Law F's value-position
 *    analog). Legal only under fixed arity (an unbounded variadic has no parameter
 *    list to eta-expand).
 *  - `"door"`: first-class use cannot be honest in v1 — a named compile error. */
export type RefPolicy = "eta" | "shim" | "door";

/** The compile's ambient knobs a rule may branch on — register, framework axis,
 *  opinions. NEVER asyncness (rules are async-blind — Law W owns awaits) and NEVER
 *  effects (the optimization gates read `provenance`/`cacheClass` at the engine level,
 *  not in rules). */
export interface EmitConfig {
  /** Which emitter register this compile targets: `"run"` = the executable artifact;
   *  `"read"` = the human-grade reading view. */
  readonly register: "run" | "read";
  /** Framework axis for capability rules that emit framework-specific residuals
   *  (`infer`'s vercel/langchain branch). An OPEN string — the branch keys are each
   *  rule-owning component's vocabulary, not an enum owned here. */
  readonly framework?: string;
  /** Named compiler opinions (formatting/idiom toggles). Open bag by design — an opinion
   *  lands with its consuming rule/pass, never pre-enumerated here. */
  readonly opinions?: Readonly<Record<string, unknown>>;
}

/** Everything an emit rule may consult — a plain object literal the engine assembles per
 *  call site. Carries no asyncness in any form: a rule cannot see or branch on it (Law W).
 *
 *  `R` = the Residual algebra (opaque here; see the module header). */
export interface EmitCtx<R = unknown> {
  /** Per-argument facts — Law F applies (absence ⇒ the rule's conservative branch). */
  argFacts: TypeFacts[];
  /** Contextual/expected type of the call's OWN result when known. Scoped to the call
   *  itself — never parent-node peeking: cross-node idioms live in named engine
   *  peepholes (Law C), not in rules inspecting what consumes them. */
  selfFacts?: TypeFacts;
  config: EmitConfig;
  /** Opaque origin handle for the CoreForm node this residual is produced FOR — zero
   *  type contract on this side (CoreForm's NodeId is compiler-package-local; typing it
   *  here would invert the layering rule's dependency direction). Inert by design: origin
   *  spans thread via copy-forward in the pass that builds residuals; this handle exists
   *  for the one case copy-forward can't cover (a rule minting a node with no 1:1
   *  CoreForm origin). Consumers must treat it as optional. */
  originHint?: unknown;
  /** Hygienic temp via the namer's reservation pass. Returns the namer's opaque Binding
   *  handle — typed `unknown` so it does not pre-claim the compiler's `Binding` export. */
  fresh(hint: string): unknown;
  /** Sugar for `RuntimeRef(symbol)` — the frame-as-query mechanism: FRAME scans the
   *  finished tree and materializes exactly the imports that occur. */
  runtime(symbol: string): R;
  /** Typed refusal — surfaces as a compile diagnostic, never a silent miscompile. */
  door(reason: string): never;
}

/** The idiomatic-residual rewrite a Contract may carry (`Contract.emit`). Absent ⇒ the
 *  fallback ladder's rung 3 (the RuntimeRef shim) — silence is impossible by construction
 *  (rule → eta-ref → shim → door).
 *
 *  Rules are async-blind (Law W: never mint `Await`, never see asyncness — emit
 *  sync-shaped residuals; ASYNC-IFY's post-emit dataflow places every await) and
 *  effect-blind (provenance/cacheClass gate at the engine, not here). Rules must be
 *  STATIC data on the declaration — a builder-form capability whose rule shape depends
 *  on activation state is a harvest-time error. */
export interface EmitRule<R = unknown> {
  /** Application position: `(sym a b …)` → residual. `args` are already-lowered
   *  residuals — a rule cannot inspect what its argument syntactically WAS (Law A:
   *  residual selection keys on argument FACTS, never on syntax or result types). */
  call(args: readonly R[], ctx: EmitCtx<R>): R;
  /** Value position (`(map sym xs)`). Rarely hand-written — see `RefPolicy`: the default is
   *  the engine-derived eta-expansion of `call` (`"eta"`) or the RuntimeRef shim
   *  (`"shim"`, the default). */
  ref?(ctx: EmitCtx<R>): R;
}
