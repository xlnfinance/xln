// capability-internals — sibling contract between `common/capability.ts` and
// `env/vocabulary.ts`, not part of the capability-authoring public surface
// (`EnvCapability`/`SymbolDeclaration`/`ImplThis`). NOT package.json-exported under any
// subpath — relative import only (`env/vocabulary.ts`, `type-layer/prelude.ts`); no
// stability contract; may change with the bind loop that consumes it.
//
// Bind-loop helpers: alias/declarative dispatch, contract projection, `requiresConfig`
// auto-door miss collection, prelude/`symbol.define` harvesting for type-lens.

import type { AEntity, DefineSymbolDef, DefineSyntaxSymbolDef, MacroSymbolDef } from "./symbols/_bake.js";
import type { AliasSymbolDef } from "./symbols/alias.js";
import type { EnvCapability, SymbolDeclaration } from "./capability.js";
import type { DegradedCapability, DegradedNeed } from "./degradation.js";
import { AKernelKeyword } from "../values/AKernelKeyword.js";
import { DoorProcedure } from "../values/primitives/ACallable.js";
import { ANativeProcedure } from "../values/primitives/ANativeProcedure.js";
import { ARosettaProcedure } from "../values/primitives/ARosettaProcedure.js";

/** `symbol.alias` marker — see `alias.ts` for dissolution semantics. Checked BEFORE every
 *  other dispatch in the apply loop (`kind: "alias"` is outside the minted-value family and
 *  the three declarative kinds). */
export const isAliasDef = (m: SymbolDeclaration): m is AliasSymbolDef =>
  typeof m === "object" && m !== null && (m as { kind?: unknown }).kind === "alias";

/** The three declarative record kinds — `symbol.define`/`symbol.defineSyntax` (two-phase
 *  carve-out) and `symbol.macro` (already hands over a real `Macro`, stays a
 *  `{kind, name, macro}` record so `preludeOnly` routing has somewhere to live). Every other
 *  kind mints its A-value directly (see `SymbolDeclaration`); a plain object carrying one of
 *  these three `kind` tags is unambiguous — none of the minted classes' own `.kind`
 *  (`"procedure"`/`"keyword"`/ordinary scheme-value kinds) collides with
 *  `"define"`/`"define-syntax"`/`"macro"`. */
export const isDeclarativeDef = (m: SymbolDeclaration): m is MacroSymbolDef | DefineSymbolDef | DefineSyntaxSymbolDef =>
  typeof m === "object" &&
  m !== null &&
  "kind" in m &&
  ((m as { kind: unknown }).kind === "macro" ||
    (m as { kind: unknown }).kind === "define" ||
    (m as { kind: unknown }).kind === "define-syntax");

/** Extract a `SymbolDeclaration` entry's `AEntity` CONTRACT view for read-only introspection
 *  (describe/catalog in `eval/exec-phases.ts`, type-lens harvest in
 *  `type-layer/prelude.ts`/`schema-to-ts.ts`, mercury registry). Dispatches by `instanceof`
 *  like the bind loop — pure dry projection, never invokes. `undefined` when no contract:
 *  `symbol.alias` (resolve target first), and the bigint-leaf gap `symbol.value` documents
 *  (a JS primitive cannot carry a hidden property to stamp).
 *
 *  `symbol.value` stamps its own `{kind:"value",name,doc}` onto the minted/boxed value's
 *  `.contract` (own, non-enumerable, define-once — see `value.ts`), the same slot every other
 *  kind rides — the generic `"contract" in def` fallback picks it up with no per-kind case. */
export function contractOf(def: SymbolDeclaration): AEntity | undefined {
  if (def instanceof DoorProcedure) return def.door;
  if (def instanceof ANativeProcedure || def instanceof ARosettaProcedure) return def.contract as AEntity;
  if (def instanceof AKernelKeyword) return { kind: "keyword", name: def.name };
  if (isDeclarativeDef(def)) return def;
  if (typeof def === "object" && def !== null && "contract" in def) {
    return (def as { contract?: AEntity }).contract;
  }
  return undefined;
}

/** `Contract.requiresConfig` auto-derive gate (`./symbols/_bake.js`): declared keys ABSENT
 *  from this activation's validated `configuration` — `undefined` when no `requiresConfig` or
 *  every declared key is present (zero-cost majority path). Read unconditionally by
 *  `native`/`rosetta` bind arms. Bare-required keys throw at `schema.parse`;
 *  `requiresConfig` doors optional keys the verb names. */
export const missingRequiresConfig = (
  requiresConfig: readonly (string | readonly string[])[] | undefined,
  configuration: Record<string, unknown>,
): readonly (string | readonly string[])[] | undefined => {
  if (requiresConfig === undefined || requiresConfig.length === 0) return undefined;
  // A group entry (`readonly string[]`) is ANY-OF: missing only when EVERY key is absent.
  const missing = requiresConfig.filter((entry) =>
    typeof entry === "string"
      ? configuration[entry] === undefined
      : entry.every((key) => configuration[key] === undefined),
  );
  return missing.length === 0 ? undefined : missing;
};

/** Keys a door's `cause.needs` carries for a missing set — group entries flattened
 *  (each key in an any-of group is a real enabling key; either-of semantics live in the
 *  reason text; `cause.needs` stays the flat `configuration`-key list every reader expects). */
export const requiresConfigNeeds = (missing: readonly (string | readonly string[])[]): readonly string[] =>
  missing.flatMap((entry) => (typeof entry === "string" ? [entry] : [...entry]));

/** Auto-door misses for `Vocabulary.degraded`: bind loop mints `requiresConfig` doors as
 *  bound `DoorProcedure`s WITHOUT writing a `DoorSymbolDef` back into `symbolsRec`, so
 *  `collectDegraded`'s record scan cannot see them — this sibling scan reads misses off the
 *  baked defs; bind loop merges both views via {@link mergeDegraded}. */
export const collectRequiresConfigDegraded = (
  capabilityName: string,
  symbolsRec: Record<string, SymbolDeclaration>,
  configuration: Record<string, unknown>,
): DegradedCapability | undefined => {
  const seen = new Set<string>();
  const needs: DegradedNeed[] = [];
  for (const rawDef of Object.values(symbolsRec)) {
    // `requiresConfig` rides `.contract` on a minted native/rosetta — `contractOf` is the
    // shared read-side seam every describe/catalog/harvest reader already dispatches through.
    const entity = contractOf(rawDef);
    if (entity === undefined || !("requiresConfig" in entity)) continue;
    const missing = missingRequiresConfig(entity.requiresConfig, configuration);
    if (missing === undefined) continue;
    for (const key of requiresConfigNeeds(missing)) {
      if (seen.has(key)) continue;
      seen.add(key);
      needs.push({ kind: "configuration", key });
    }
  }
  return needs.length === 0 ? undefined : { capability: capabilityName, needs };
};

/** Merge the two degraded views (door record scan + requiresConfig def scan),
 *  deduped by need key; `undefined` when both are. */
export const mergeDegraded = (
  a: DegradedCapability | undefined,
  b: DegradedCapability | undefined,
): DegradedCapability | undefined => {
  if (a === undefined) return b;
  if (b === undefined) return a;
  const seen = new Set(a.needs.map((need) => `${need.kind}:${need.key}`));
  return {
    capability: a.capability,
    needs: [...a.needs, ...b.needs.filter((need) => !seen.has(`${need.kind}:${need.key}`))],
  };
};

/** Auto-derived door's teaching reason — same "provide X to enable it" register
 *  `degradation.ts`'s `.door(name, needs, reason)` callers write by hand, minted
 *  mechanically from the declaring verb's OWN `doc`. An any-of group renders as
 *  "`fs` or `loader`" with a "one of them" pronoun. */
export const requiresConfigReason = (
  missing: readonly (string | readonly string[])[],
  doc: string | undefined,
): string => {
  const keysClause = missing
    .map((entry) => (typeof entry === "string" ? `\`${entry}\`` : entry.map((key) => `\`${key}\``).join(" or ")))
    .join(", ");
  const pronoun = missing.length === 1 ? (typeof missing[0] === "string" ? "it" : "one of them") : "them";
  const docClause = doc === undefined ? "" : ` (${doc})`;
  return `requires configuration ${keysClause} — provide ${pronoun} to enable this verb.${docClause}`;
};

/** Every `.spec.prelude` reachable from `caps`, DAG order (a dep's prelude precedes its
 *  dependent's — matching `env/vocabulary.ts`'s deps-first bind order, so a dependent's
 *  prelude may reference names its dep's prelude defined), deduplicated by capability
 *  IDENTITY (diamond-shaped dep graphs must not double-emit a shared dep's prelude).
 *
 *  For an editor/type-lens ambient scheme vocabulary: walk the actually-assembled capability
 *  set, never a hand-picked subset — a hand-picked list silently drifts when a prelude changes
 *  or a new capability joins the root-set. */
export function collectPrelude(caps: readonly EnvCapability[], seen: Set<EnvCapability> = new Set()): string {
  const parts: string[] = [];
  for (const cap of caps) {
    if (seen.has(cap)) continue;
    seen.add(cap);
    if (cap.spec.deps !== undefined) {
      const depsPrelude = collectPrelude(cap.spec.deps, seen);
      if (depsPrelude !== "") parts.push(depsPrelude);
    }
    if (cap.spec.prelude !== undefined) parts.push(cap.spec.prelude);
  }
  return parts.join("\n");
}

/** Serialize a capability DAG's scheme-bodied `symbol.define`s as `(define <verb> <body>)`
 *  source — type-lens compile-path counterpart to {@link collectPrelude}'s `prelude:`
 *  strings. A `symbol.define`'s `body` is its RHS EXPRESSION (`(lambda () "string")` for
 *  `s/string`), bound at runtime under its own record key (`env/vocabulary.ts`
 *  `processCapability` Pass-2). Emitting the same `(define verb body)` lets a type-lens
 *  infer each symbol's type FROM ITS OWN BODY — runtime binding and editor type from one
 *  source. Deps FIRST (a dependent body may reference a base define — `s/field/string`
 *  calls `s/field`), deduped by the shared `seen` set like `collectPrelude`.
 *
 *  `kind: "define"` entries emit their real body. Polyglot `symbol.native`s that carry an
 *  authored `type` (`str`, `join`) have no scheme body — they stay native at runtime to
 *  avoid a strings/srfi-13 dep — so the lens gets a rest-lambda stub. Restricted to
 *  `scheme/polyglot*` so R7RS natives with `type` do not shadow the TS builtin prelude.
 *
 *  NOT for runtime prelude eval: bind loop already binds these via `bindCapabilityDefines`;
 *  re-running as prelude would double-bind. Feeds a type-lens `schemePrelude` only. */
export function collectSymbolDefines(caps: readonly EnvCapability[], seen: Set<EnvCapability> = new Set()): string {
  const parts: string[] = [];
  for (const cap of caps) {
    if (seen.has(cap)) continue;
    seen.add(cap);
    if (cap.spec.deps !== undefined) {
      const depDefines = collectSymbolDefines(cap.spec.deps, seen);
      if (depDefines !== "") parts.push(depDefines);
    }
    const symbols = cap.spec.symbols;
    if (symbols === undefined) continue;
    const polyglotNatives = cap.name.startsWith("scheme/polyglot");
    for (const [key, def] of Object.entries(symbols)) {
      if (def !== null && typeof def === "object" && "kind" in def && def.kind === "define") {
        parts.push(`(define ${key} ${(def as DefineSymbolDef).body})`);
        continue;
      }
      if (polyglotNatives && def instanceof ANativeProcedure) {
        const type = def.contract && "type" in def.contract ? def.contract.type : undefined;
        if (typeof type === "string") parts.push(`(define ${key} (lambda args ""))`);
      }
    }
  }
  return parts.join("\n");
}
