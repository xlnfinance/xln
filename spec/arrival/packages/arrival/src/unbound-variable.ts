// unbound-variable — the ONE builder for the "Unbound variable" error object, shared
// by every arrival-side throw site (`AmbientRuntime.ts#get`, `eval/Resolver.ts#resolveSynth`,
// `eval/evaluator.ts#resolvedBindingOrThrow`), plus the TYPO-SUGGESTION mechanism that
// enriches it.
//
// The suggestion machinery stays zero-imports: throw sites sit at/below the eval layer,
// so this module must be importable from anywhere in the graph with no cycle risk. The
// one exception is `UnboundVariableError` itself (`errors.ts`, zero imports beyond
// `ArrivalError`) — importing it here carries no cycle risk either.
//
// Deliberately NO static curated table of "well-known" names. Such a table is declaration
// data smuggled into the error path: every row duplicates either a REAL binding
// (env/polyglot/polyglot.ts, the SRFI/R7RS packs) or a DECLARED `symbol.notImplemented`
// door (env/polyglot/polyglot-stubs.ts, env/srfi/srfi-stubs.ts, env/r7rs/host.ts) — and a
// genuinely-absent well-known name (e.g. SRFI-1's bare `fold`) belongs as a declared door
// in its own pack (env/srfi/srfi-1.ts), not a table row. Teaching about well-known-but-
// absent names is CAPABILITY DATA resolving through the ordinary chain, not a special
// error path.
//
// What remains is the half that CANNOT be declared: a MISTYPED name has no declaration
// site. Suggestions derive from the resolution chain's ACTUAL vocabulary (every name
// bound in the env the miss happened against — passed in by the throw site):
//   • a typo of a REAL bound symbol suggests that symbol — including prelude-defined
//     names and per-env tool verbs;
//   • declared notImplemented doors ARE bindings, so declaring a stub makes it
//     typo-suggestible for free (suggest the door; calling the door teaches the reason);
//   • a typo of a LEXICALLY bound program name (a user `define`) suggests it too — the
//     Resolver passes its composed scope+capabilities vocabulary.
//
// GATING (load-bearing): a suggestion fires ONLY for a close miss of a name that
// actually exists in the vocabulary — an arbitrary unbound identifier (`csv-content`)
// matches nothing and gets the PLAIN message, with no hint appended. A wrong hint is
// poison; under-trigger, never guess.

import { UnboundVariableError } from "./errors.js";

/** Names the RESOLVER SYNTHESIZES structurally rather than binding (`c[ad]+r`
 *  composition, eval/Resolver.ts#cxrUnfold) — absent from every enumerable vocabulary
 *  by construction (the family is infinite), so the two base cases are seeded as
 *  always-present suggestion candidates: a typo like `cair` should still route to
 *  `car`. Kernel-structural, interpreter-universal — hardcoding them here is honest. */
const SYNTH_NAMES: readonly string[] = ["car", "cdr"];

/** How many nearby names a hint carries at most — enough to disambiguate a tie,
 *  few enough to stay one line (manifold's H-4 one-line-wall contract). */
const MAX_SUGGESTIONS = 3;

/** Lowercase + strip WORD-SEPARATOR noise only (`-`/`_`/whitespace) — collapses
 *  dash/underscore/case/spacing variance (`string_split` / `STRING-SPLIT` /
 *  `String Split` all collapse to the same key as `string-split`) so a
 *  spelling-convention miss is caught even when its raw edit distance is > 1.
 *  Every OTHER character stays significant: a trailing `?`/`!` is Scheme's own
 *  predicate/mutator sigil (`dict` vs `dict?` are distinct bindings), and
 *  punctuation-only spellings (`->`, `->>`, `~>`, `@`, `@?`) are the ENTIRE
 *  identity of those names. */
function canonicalize(s: string): string {
  return s.toLowerCase().replaceAll(/[-_\s]/g, "");
}

/** Locale-independent, code-unit-wise comparator (suggestion ordering must be
 *  deterministic across realms/locales; localeCompare is neither). */
function byCodeUnit(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/** Levenshtein edit distance, capped: returns as soon as it's provably > `max`,
 *  since the suggester only ever asks "is this ≤ 1 away". */
function editDistanceAtMost(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const m = a.length;
  const n = b.length;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      cur.push(v);
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > max) return max + 1;
    prev = cur;
  }
  return prev[n];
}

/**
 * Nearby REAL names for an unbound miss, from the chain's actual vocabulary.
 * Two gates, canonical-form first:
 *   1. CANONICAL-FORM match — same letters/digits once case and `-`/`_`/space are
 *      stripped (a spelling-convention miss: `string_split`, `StringSplit`).
 *   2. EDIT-DISTANCE ≤ 1 on the raw strings — a genuine one-character typo
 *      (`reduse` → `reduce`). LENGTH FLOOR: both sides must be ≥ 3 chars — every
 *      1-char name is one substitution from every other, so a short unbound
 *      variable would get a wrong hint that SHADOWS the doors owning that case
 *      (scope-confusion, quoting).
 *
 * Candidate filter: string keys only (symbol-keyed bindings aren't spellable),
 * `%`-prefixed names excluded (kernel-internal convention, never a user target).
 * An unbound name can never be its own exact vocabulary member (it would have
 * resolved), but the self-exclusion is kept as a cheap invariant for glass callers
 * enumerating a DIFFERENT env than the one that missed.
 */
export function suggestFromVocabulary(unboundName: string, vocabulary: Iterable<string | symbol>): readonly string[] {
  const candidates = new Set<string>(SYNTH_NAMES);
  for (const key of vocabulary) {
    if (typeof key !== "string") continue;
    if (key.startsWith("%")) continue;
    candidates.add(key);
  }
  candidates.delete(unboundName);

  const canonical = canonicalize(unboundName);
  const canonicalHits: string[] = [];
  for (const candidate of candidates) {
    if (canonicalize(candidate) === canonical) canonicalHits.push(candidate);
  }
  if (canonicalHits.length > 0) return canonicalHits.toSorted(byCodeUnit).slice(0, MAX_SUGGESTIONS);

  if (unboundName.length < 3) return [];
  const nearHits: string[] = [];
  for (const candidate of candidates) {
    if (candidate.length < 3) continue;
    if (editDistanceAtMost(unboundName, candidate, 1) <= 1) nearHits.push(candidate);
  }
  return nearHits.toSorted(byCodeUnit).slice(0, MAX_SUGGESTIONS);
}

// ─── Idiom routing ────────────────────────────────────────────────────────────
//
// A DISJOINT, NAME-EXACT gate from the fuzzy vocabulary matcher above: names with
// no declaration site AND no near-vocabulary match — a model reaching for another
// dialect's syntax, or a capability that sounds standard but
// was never bound here (`require`, `read-all`). Names that ARE declared doors (e.g.
// `with-input-from-file` in env/r7rs/host.ts) must NOT appear here — dual-path is a
// lie (unbound-variable routing never runs once the name resolves as a live door).
// Fuzzy suggestion would never fire on these (edit distance from "require" to any
// bound name is nowhere near 1), so this table is additive, not a competing heuristic
// — same family as the `SYNTH_NAMES` seed above (car/cdr), just keyed by exact
// name/prefix instead of being structurally synthesized. Doctrine: models reach for
// the dialect they know; give them the name, guard the shape loudly.

/** No-file-IO explanation for unbound file/port idioms that have no host door: the
 *  sandbox has no filesystem or port layer by design — a tool's own result already IS
 *  the data; parse it in-program. Live host doors (with-input-from-file, open-input-file,
 *  …) teach via their own `symbol.notImplemented` reason instead. */
const NO_FILE_IO_HINT =
  "there is no file/port IO in this sandbox; the tool's own result is already the data — parse it with (detect-parse s).";

/** Exact-name idiom routes: a name with no declaration site, routed to its native form.
 *  ONLY truly-unbound names — if a name is a BASE_PACKS door, drop it from here. */
const IDIOM_ROUTES: ReadonlyMap<string, string> = new Map([
  ["require", "the parsers are already bound here — try (parse-json s) or (detect-parse s), not require."],
  ["read-all", NO_FILE_IO_HINT],
  // Free `,` / `,@` outside quasiquote: the reader always expands them to (unquote …)
  // / (unquote-splicing …); evaluating that as a call looks up the name and hits this
  // door. Not a missing capability — unquote is syntax only inside `` ` ``.
  [
    "unquote",
    "`,` is R7RS unquote — only legal inside quasiquote (`…`). A free `,x` or `(unquote x)` " +
      "is evaluated as a call and fails. Scheme lists use spaces, not JS commas: write " +
      "(list 1 2 3), not (list 1, 2, 3). Inside `[…]` / `{…}` one comma per element " +
      "boundary is absorbed as a separator (docs/grammar.md §COMMA).",
  ],
  [
    "unquote-splicing",
    "`,@` is R7RS unquote-splicing — only legal inside quasiquote (`…`). Free `,@xs` outside " +
      "` is evaluated as a call and fails.",
  ],
]);

/** Known dead-end idioms (name-exact). `#:name` mints as the keyword `:name` at
 *  `ASymbol` construction (identical to arrival's spelling), so it never reaches
 *  unbound-variable. */
function idiomRoutingHint(name: string): string | undefined {
  return IDIOM_ROUTES.get(name);
}

/**
 * Builds the thrown Error. `vocabulary` is the throw site's enumeration of every name
 * its resolution walk could have found (`AmbientRuntime.allBoundNames()`,
 * `Resolver.allBoundNames()`, the sealed chain's `names`); omitted/empty ⇒ the plain
 * wall, no hint machinery at all (the evaluator's defensive unreachable-branch throw).
 *
 * The hint (when a near name exists, OR the name matches a known dead-end idiom — see
 * `idiomRoutingHint`, checked FIRST since it's name-exact and cheaper) rides both
 * `.message` (the thrown Error) and `.publicMessage` (the model/agent-facing string);
 * with no hint both fall back to the plain wording — a pure addition, never a regression.
 *
 * `enriched` is a THIRD, STRUCTURED signal alongside the two wording fields:
 * unambiguously true iff a did-you-mean suffix OR an idiom routing hint was appended.
 * A consumer that needs "did arrival already enrich this?" asks a typed boolean instead
 * of sniffing the SHAPE of `.message`.
 */
export function unboundVariableError(name: string, vocabulary: Iterable<string | symbol> = []): UnboundVariableError {
  const routingHint = idiomRoutingHint(name);
  if (routingHint !== undefined) return new UnboundVariableError(name, [], routingHint);
  return new UnboundVariableError(name, suggestFromVocabulary(name, vocabulary));
}
