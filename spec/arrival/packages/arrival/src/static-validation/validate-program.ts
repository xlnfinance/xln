// validate-program — STATIC VALIDATION PASS: the compiler's front door, not a
// provenance artifact (provenance/ modules CONSUME forms; this one JUDGES them).
// Composes the reference walk (collect-references.ts), the graph (reference-graph.ts),
// assembled vocabulary (vocabulary.ts), introspectable doors, degradation-minted causes,
// and `suggestFromVocabulary` into ONE eslint-style pass: the COMPLETE `Diagnostic[]`,
// never crash-on-first. Only the CALLER decides to throw (`exec` aggregates error-tier
// diagnostics into one `StaticValidationError` at parse phase, before the first form
// evaluates).
//
// SOUNDNESS CONTRACT — static-validator voice of the one conservative-narrowing law
// (DEGRADE TO WARNING, NEVER A FALSE POSITIVE: docs/static-plane.md §CONSERVATIVE
// NARROWING): the `error` tier advertises no spurious `unbound-symbol` errors MODULO
// the EXCLUDED reachability strictness — a dead-branch reference (`(if #f (missing) 42)`)
// reports BY DESIGN (dead references are drift) and is not a false positive; it is the
// one deliberate divergence from runtime semantics, opt-out documented on the exec knob.
// Four leak sources closed by construction:
// (1) SPECIAL_FORMS/keyword heads — unconditional KEYWORD_SYNTAX baseline (vocabulary.ts);
// (2) binder-macro formals — ternary firewall ("binder" is opaque-equivalent until a
//     binding-aware walker exists);
// (3) program-level `define-macro`/`define-syntax` names — macro-aware first sweep below;
// (4) internal-define sequences — walker's body-sequence letrec* pre-pass.
// Anything unproven degrades to `warning` (impure-resolver switch) or is not emitted
// (macro firewall). Suggestions are the one explicitly-heuristic channel, labeled
// ("did you mean") and bound by the suggestion-soundness law below.
//
// DISPLAY DISCIPLINE: a content hash NEVER appears in diagnostic text; every identity
// resolves to `name @ capability`. No Diagnostic field carries a hash.
//
// EVAL ⇄ STATIC-VALIDATION — a declared two-file mutual, not a second knot (hermeticity
// audit D6): `vocabulary.ts` type-imports `eval/CompiledResolutionChain.ts` and
// value-imports `eval/Macro.ts` (the sealed chain this validator judges, and the macro
// class its firewall treats as opaque). `eval/exec-phases.ts` imports `validateProgram`/
// `vocabularyFromChain` from here, and `eval/generator-exec.ts` imports
// `StaticValidationError` from here, back — the evaluator calls this pass at parse phase,
// before the first form evaluates (line 7 above). `docs/strata.md` §3 names this the
// declared exception to "static-validation is one-directional above the knot."

import type { SourceLocation } from "../errors.js";
import type { SchemeValue } from "../values/types.js";
import type { DoorCause } from "../common/symbols/_bake.js";
import { APair } from "../values/primitives/APair.js";
import { ASymbol } from "../values/primitives/ASymbol.js";
import { suggestFromVocabulary } from "../unbound-variable.js";
import { collectReferences, definitionOf, type MacroWalkAttribute } from "./collect-references.js";
import { buildReferenceGraph, type DoorNode, type MissingConfigNode, type ReferenceNode } from "./reference-graph.js";
import type { ProgramVocabulary, VocabularyEntry } from "./vocabulary.js";

/** ONE reference site — where the program touched the problem. `span` is the
 *  referencing Pair's location (the reader guarantees every Pair carries one); the
 *  zero location stands in only for a form with no located enclosing Pair (a bare
 *  top-level symbol handed in synthetically). */
export interface SiteRef {
  readonly symbol: string;
  readonly span: SourceLocation;
}

/** CASCADE FUSION (same posture as Elm/ESLint): a Diagnostic is keyed by its CAUSE and
 *  carries the COMPLETE list of sites that cause explains. One missing `fs` key
 *  disabling require + require/extension, referenced 7 times, is ONE diagnostic with 7
 *  sites — never 7 diagnostics. The grouping key is the CURE: the config key for
 *  bucket c, the door for bucket b, the unknown NAME for bucket a. */
export interface Diagnostic {
  readonly severity: "error" | "warning";
  readonly code: // closed vocabulary, additive
    | "unbound-symbol" // bucket a (key: the unknown name)
    | "bound-to-door" // bucket b (key: the door — a cause-less/needs-less door's own teaching reason is the cure)
    | "missing-configuration" // bucket c (key: the config key — assembled mode: a door whose need is config)
    | "arity-mismatch"; // bucket d — DEFERRED, no producer yet
  /** Every reference this ONE cause explains, in program order — never a lone "first site". */
  readonly sites: readonly SiteRef[];
  /** Host-facing: cause first, then the site list. Identities as `name @ capability`, never a hash. */
  readonly message: string;
  /** Agent-facing (the unbound-variable.ts publicMessage split, reused). */
  readonly publicMessage: string;
  /** Buckets b/c — the causal chain, structured (door → owner → needs). */
  readonly cause?: DoorCause;
  /** Bucket a — the SOUND subset only: candidates that would themselves
   *  VALIDATE under the present grants; a door is NEVER offered as a typo fix. */
  readonly suggestions?: readonly string[];
}

/** The eslint discipline as an API shape: the pass RETURNS, the caller throws.
 *  `exec` wraps error-tier diagnostics in this, one per line, at parse phase. */
export class StaticValidationError extends Error {
  readonly diagnostics: readonly Diagnostic[];
  constructor(diagnostics: readonly Diagnostic[]) {
    const errors = diagnostics.filter((d) => d.severity === "error");
    super(
      `Static validation found ${errors.length} error${errors.length === 1 ? "" : "s"} — nothing was evaluated:\n${errors
        .map((d) => `  • ${d.message}`)
        .join("\n")}`,
    );
    this.name = "StaticValidationError";
    this.diagnostics = diagnostics;
  }
}

const ZERO_LOCATION: SourceLocation = { line: 0, col: 0, offset: 0 };

const siteOf = (name: string, ref: ReferenceNode): SiteRef => ({ symbol: name, span: ref.span ?? ZERO_LOCATION });
const at = (s: SiteRef): string => `${s.span.line}:${s.span.col}`;
const siteList = (sites: readonly SiteRef[]): string => sites.map(at).join(", ");

/** The macro-aware FIRST SWEEP: the program's own top-level definition names —
 *  `define` (values) vs `define-macro`/`define-syntax` (macros; their call-site
 *  interiors keep the firewall). Recurses through top-level `(begin …)` splices
 *  (R7RS §5.6.1). A program's forward reference between its own top-level forms is
 *  ordinary top-level semantics, never a diagnostic. */
function collectProgramDefinitions(forms: readonly SchemeValue[]): {
  values: Set<string>;
  macros: Set<string>;
} {
  const values = new Set<string>();
  const macros = new Set<string>();
  const visit = (form: unknown): void => {
    if (form instanceof APair && form.car instanceof ASymbol && form.car.__name__ === "begin") {
      let cur: unknown = form.cdr;
      while (cur instanceof APair) {
        visit(cur.car);
        cur = cur.cdr;
      }
      return;
    }
    const def = definitionOf(form);
    if (def === null) return;
    (def.head === "define" ? values : macros).add(def.name);
  };
  for (const form of forms) visit(form);
  return { values, macros };
}

/**
 * THE PASS: parsed program forms × a vocabulary → the COMPLETE diagnostic list. NEVER
 * throws on program content; ALWAYS returns every diagnostic the graph queries yield,
 * ordered by first reference site.
 */
export function validateProgram(forms: readonly SchemeValue[], vocabulary: ProgramVocabulary): readonly Diagnostic[] {
  const defs = collectProgramDefinitions(forms);

  // Sweep 2 — the site-collecting reference walk, per top-level form, with the ternary
  // firewall composed from program macros (always "opaque" — unaudited) and
  // the vocabulary's declared attributes.
  const macroPolicyOf = (name: string): MacroWalkAttribute | undefined => {
    if (defs.macros.has(name)) return "opaque";
    const entry = vocabulary.lookupStatic(name);
    return entry?.kind === "macro" ? entry.macroAttribute : undefined;
  };
  const occurrences = forms.flatMap((form) => collectReferences(form, { initialBound: defs.values, macroPolicyOf }));

  const resolve = (name: string): VocabularyEntry | { readonly kind: "program" } | undefined =>
    defs.values.has(name) || defs.macros.has(name) ? { kind: "program" } : vocabulary.lookupStatic(name);
  const graph = buildReferenceGraph(occurrences, resolve);

  // ── The buckets, each a graph QUERY ─────────────────────────────────────────────

  const diagnostics: { firstOrder: number; diagnostic: Diagnostic }[] = [];

  // Bucket a — `unbound-symbol`: one diagnostic per MissingSymbolNode, all sites
  // attached. Suggestions from the SATISFIED subset only: a door is never
  // offered as a typo fix — a suggestion that immediately re-errors on the next
  // round-trip destroys agent trust faster than no suggestion. Composes mechanically:
  // filter the candidate iterable before `suggestFromVocabulary`.
  const satisfied = ((): string[] => {
    const out: string[] = [];
    for (const key of vocabulary.names) {
      if (typeof key !== "string") continue;
      if (vocabulary.lookupStatic(key)?.kind === "door") continue;
      out.push(key);
    }
    for (const n of defs.values) out.push(n);
    for (const n of defs.macros) out.push(n);
    return out;
  })();
  for (const node of graph.missingSymbols.values()) {
    const sites = node.references.map((r) => siteOf(node.name, r));
    const suggestions = suggestFromVocabulary(node.name, satisfied);
    const hint = suggestions.length === 0 ? "" : ` — did you mean ${suggestions.map((s) => `\`${s}\``).join(" or ")}?`;
    // The impure-resolver downgrade: honesty over strictness, per-chain, visible.
    const impure = vocabulary.hasImpureResolver;
    const message = `Unbound symbol \`${node.name}\`${hint} Referenced at ${siteList(sites)}${
      impure
        ? " (a dynamic resolver in this assembly may still answer it at runtime)."
        : " — this program would crash there."
    }`;
    const publicMessage = `symbol ${node.name} does not exist - look at list of available functions at tool description${
      suggestions.length === 0 ? "" : ` (did you mean ${suggestions.map((s) => `\`${s}\``).join(" or ")}?)`
    }`;
    diagnostics.push({
      firstOrder: node.references[0].order,
      diagnostic: {
        severity: impure ? "warning" : "error",
        code: "unbound-symbol",
        sites,
        message,
        publicMessage,
        ...(suggestions.length > 0 ? { suggestions } : {}),
      },
    });
  }

  // Bucket c — `missing-configuration`: group ReferenceNodes by the MissingConfigNode
  // their resolution path terminates in (cascade fusion, structural). One absent key,
  // one diagnostic, every cured reference across every door it disables.
  const doorsExplainedByConfig = new Set<DoorNode>();
  for (const cfg of graph.missingConfigs.values()) {
    const referencedDoors = cfg.doors.filter((d) => d.references.length > 0);
    if (referencedDoors.length === 0) continue; // present in the assembly, untouched by this program
    for (const d of referencedDoors) doorsExplainedByConfig.add(d);
    diagnostics.push({
      firstOrder: Math.min(...referencedDoors.map((d) => d.references[0].order)),
      diagnostic: missingConfigDiagnostic(cfg, referencedDoors),
    });
  }

  // Bucket b — `bound-to-door`: a referenced door WITHOUT a config cure (authored
  // `notImplemented` teaching doors, cause-less or needs-less). A door already
  // explained by a missing-configuration diagnostic is NOT double-reported — its
  // cure is the config key, and that diagnostic carries its sites.
  for (const door of graph.doors.values()) {
    if (door.references.length === 0 || doorsExplainedByConfig.has(door)) continue;
    const sites = door.references.map((r) => siteOf(door.name, r));
    const identity = door.owner === undefined ? `\`${door.name}\`` : `\`${door.name} @ ${door.owner}\``;
    const message =
      `${identity} is not available in this assembly — ${door.door.reason}. ` +
      `Referenced at ${siteList(sites)} — this program would crash there.`;
    const publicMessage = `${door.name} is not available: ${door.door.reason}`;
    diagnostics.push({
      firstOrder: door.references[0].order,
      diagnostic: {
        severity: "error",
        code: "bound-to-door",
        sites,
        message,
        publicMessage,
        // eslint-disable-next-line unicorn/no-negated-condition -- omit cause when the door has none
        ...(door.door.cause !== undefined ? { cause: door.door.cause } : {}),
      },
    });
  }

  return diagnostics.toSorted((a, b) => a.firstOrder - b.firstOrder).map((d) => d.diagnostic);
}

/** The flagship message (derived mechanically by walking the graph path —
 *  every clause is a node or edge, identities as `name @ capability`, never a hash):
 *
 *    Configuration key `fs` (a filesystem) was not provided in the exec
 *    configuration. It disables `require @ arrival/loader` (referenced at 2:1, 7:31)
 *    — this program would crash there. Provide `fs` to enable it.
 */
function missingConfigDiagnostic(cfg: MissingConfigNode, referencedDoors: readonly DoorNode[]): Diagnostic {
  const sites = referencedDoors
    .flatMap((d) => d.references.map((r) => ({ order: r.order, site: siteOf(d.name, r) })))
    .toSorted((a, b) => a.order - b.order)
    .map((x) => x.site);
  const doorClause = referencedDoors
    .map((d) => {
      const identity = d.owner === undefined ? `\`${d.name}\`` : `\`${d.name} @ ${d.owner}\``;
      const own = d.references.map((r) => siteOf(d.name, r));
      return `${identity} (referenced at ${siteList(own)})`;
    })
    .join(" and ");
  const hint = cfg.hint === undefined ? "" : ` (${cfg.hint})`;
  const message =
    `Configuration key \`${cfg.key}\`${hint} was not provided in the exec configuration. ` +
    `It disables ${doorClause} — this program would crash there. Provide \`${cfg.key}\` to enable it.`;
  const publicMessage =
    `configuration key "${cfg.key}" is missing: ${referencedDoors.map((d) => d.name).join(", ")} cannot run without it. ` +
    `Add "${cfg.key}" to the exec configuration to enable ${referencedDoors.length === 1 ? "it" : "them"}.`;
  // The structured causal chain: the first referenced door's stamped cause carries
  // owner + needs — the machine-readable dual of the prose above.
  const cause = referencedDoors.map((d) => d.door.cause).find((c) => c !== undefined);
  return {
    severity: "error",
    code: "missing-configuration",
    sites,
    message,
    publicMessage,
    // eslint-disable-next-line unicorn/no-negated-condition -- omit cause when no referenced door carries one
    ...(cause !== undefined ? { cause } : {}),
  };
}
