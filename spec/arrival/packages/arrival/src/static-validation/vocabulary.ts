// vocabulary — `ProgramVocabulary`, the roster surface `validateProgram` judges
// references against. ASSEMBLED-mode constructor is built from a SEALED
// `CompiledResolutionChain` (+ the run's session scope). Roster mode (mercury front-end,
// codemirror LSP, doc-gen — pre-assembly, over `EnvCapability.exports()`) is a separate
// consumer of the same interface.
//
// Against a sealed chain, `names` is complete for enumerable bindings and frozen for the
// assembly's lifetime — "unbound" judged at parse phase cannot be invalidated by
// evaluation. Three deliberate augmentations:
//
//   • KEYWORD_SYNTAX baseline — core's keyword-bound special-form names are an
//     UNCONDITIONAL baseline, never roster-optional: assembled realms root core
//     universally, but a hand-assembled test env may not, and `while`/`try`/
//     `define-macro` heads falling out of the modeled walk must never report unbound on
//     a pure program.
//   • RESOLVER-SYNTH family — `c[ad]+r` names are synthesized structurally by the
//     Resolver ABOVE the chain (eval/Resolver.ts cxrUnfold), absent from every
//     enumerable vocabulary by construction; recognized by the same regex.
//   • `hasImpureResolver` is always `false` here: the sealed chain is unconditionally
//     the flat-map form (no resolver-interleaving representation). The field stays on
//     `ProgramVocabulary` for the diagnostic-severity contract
//     (`validate-program.ts`'s error→warning downgrade) so a future resolver-shaped
//     producer of this interface can use it.

import type { CompiledResolutionChain } from "../eval/CompiledResolutionChain.js";
import { DoorProcedure } from "../values/primitives/ACallable.js";
import { AKernelKeyword } from "../values/AKernelKeyword.js";
import { Macro } from "../eval/Macro.js";
import { is_macro_value } from "../values/value-guards.js";
import { KEYWORD_SYNTAX_BASELINE } from "../common/symbols/define-bake.js";
import type { DoorSymbolDef } from "../common/symbols/_bake.js";
import type { DegradedCapability } from "../common/degradation.js";
import type { MacroWalkAttribute } from "./collect-references.js";

/** What a name statically resolves to — the discrimination every diagnostic bucket keys on. */
export type VocabularyEntry =
  | { readonly kind: "value" }
  | { readonly kind: "keyword" } // KEYWORD_SYNTAX — core's symbol.keyword entries
  | { readonly kind: "macro"; readonly macroAttribute: MacroWalkAttribute } // firewall ternary
  | { readonly kind: "door"; readonly door: DoorSymbolDef }; // carries DoorCause when minted/stamped

export interface ProgramVocabulary {
  /** Enumerable bindings (resolver-synthesized names deliberately absent — probed,
   *  not enumerated). The suggestion candidate pool, pre-soundness-filter. */
  readonly names: ReadonlySet<string | symbol>;
  lookupStatic(name: string): VocabularyEntry | undefined;
  /** Soundness switch: some chain resolver step is NOT `pure` — every
   *  `unbound-symbol` degrades error → warning ("may be answered dynamically"). */
  readonly hasImpureResolver: boolean;
  /** The enumerable degraded list, when the assembling caller carried it through —
   *  informational corroboration; the causal chain itself rides each door's `cause`. */
  readonly degraded: readonly DegradedCapability[];
}

/** The Resolver's structural cxr synth family (eval/Resolver.ts CXR_RE — the same
 *  kernel-structural fact, re-stated per the local-copy convention). */
const CXR_RE = /^c[ad]+r$/;

function classifyBoundValue(value: unknown): VocabularyEntry {
  if (value instanceof DoorProcedure) return { kind: "door", door: value.door };
  if (value instanceof AKernelKeyword) return { kind: "keyword" };
  if (value instanceof Macro) return { kind: "macro", macroAttribute: value.macroAttribute ?? "opaque" };
  // Brand-recognized macro shapes that don't extend Macro (Syntax / syntax-parameter):
  // no declared attribute channel — "opaque", the safe under-report default.
  if (is_macro_value(value)) return { kind: "macro", macroAttribute: "opaque" };
  return { kind: "value" };
}

export interface AssembledVocabularyOptions {
  /** The run's session-scope names (REPL accumulation frame / `LexicalScope`) —
   *  legitimately bound for THIS call (the assembled-mode constructor). */
  readonly scopeNames?: Iterable<string | symbol>;
  /** Settled scope value read (e.g. `(n) => scopeEnv.get(n, {throwError: false})`) so a
   *  scope-bound macro/door classifies correctly; scope wins over the chain (lexical
   *  precedence). Absent ⇒ scope names classify as plain values. */
  readonly scopeLookup?: (name: string) => unknown;
  /** `Vocabulary.degraded` — a capability's requiresConfig-driven auto-doors, when any. */
  readonly degraded?: readonly DegradedCapability[];
}

/**
 * The ASSEMBLED-mode `ProgramVocabulary`: a sealed chain + the run's session
 * scope. Lookups are memoized per vocabulary object — a program referencing `map`
 * 40 times costs one classification.
 */
export function vocabularyFromChain(
  chain: CompiledResolutionChain,
  opts: AssembledVocabularyOptions = {},
): ProgramVocabulary {
  const scopeNames = new Set<string | symbol>(opts.scopeNames);
  const names = new Set<string | symbol>(chain.names);
  for (const n of scopeNames) names.add(n);
  for (const k of KEYWORD_SYNTAX_BASELINE) names.add(k);

  // Sealed chain is flat-map form — unconditionally pure (see preamble).
  const hasImpureResolver = false;

  const memo = new Map<string, VocabularyEntry | undefined>();
  const lookupStatic = (name: string): VocabularyEntry | undefined => {
    if (memo.has(name)) return memo.get(name);
    let entry: VocabularyEntry | undefined;
    if (scopeNames.has(name)) {
      const scoped = opts.scopeLookup?.(name);
      entry = scoped === undefined ? { kind: "value" } : classifyBoundValue(scoped);
    } else {
      const hit = chain.lookup(name);
      if (hit !== undefined) entry = classifyBoundValue(hit);
      else if (KEYWORD_SYNTAX_BASELINE.has(name)) entry = { kind: "keyword" };
      else if (CXR_RE.test(name)) entry = { kind: "value" };
    }
    memo.set(name, entry);
    return entry;
  };

  return { names, lookupStatic, hasImpureResolver, degraded: opts.degraded ?? [] };
}
