/**
 * COPY-AS-CHUNK (constitution §4.5 — greenfield package, never shared imports).
 * Source: arrival/packages/mercury/src/names.ts (`cleanName`, `nameCandidates`,
 * `RESERVED`), verbatim.
 *
 * The pure base of the lexical-naming ladder — kebab→camel, drop predicate `?` /
 * mutate `!`, lower `->`, escape reserved words. Position-independent, so for a
 * collision-free program it is exactly the name the full namer assigns; the walker's
 * own scope-aware declare pass (walk.ts) layers `${name}_${n}` disambiguation on top.
 *
 * Adaptations from the source chunk: `elementName` (needs `pluralize` — a LEGIBILITY-pass
 * concern), `destructureTuple` (string-regex — superseded by the Residual-tree walk the
 * LEGIBILITY wave lands), and `containsAwaitToken` (string-plane async sniffing — deleted
 * by design, Law W) are not carried.
 */

/** Exported for src/naming/allocate.ts: the ROOT-scope reservation set the
 *  allocation phase unions with stage0 manifest exports + the pipeline's own
 *  hardcoded globals ("Error"/"Math"/"Promise") — the same set `cleanName`
 *  already escapes against below, so a reservation here never fights a
 *  candidate ladder that already avoided it. */
export const RESERVED = new Set([
  "break",
  "case",
  "catch",
  "class",
  "const",
  "continue",
  "debugger",
  "default",
  "delete",
  "do",
  "else",
  "export",
  "extends",
  "false",
  "finally",
  "for",
  "function",
  "if",
  "import",
  "in",
  "instanceof",
  "new",
  "null",
  "return",
  "super",
  "switch",
  "this",
  "throw",
  "true",
  "try",
  "typeof",
  "var",
  "void",
  "while",
  "with",
  "yield",
  "let",
  "static",
  "enum",
  "await",
  "async",
  "implements",
  "interface",
  "package",
  "private",
  "protected",
  "public",
  "arguments",
  "eval",
]);

/**
 * Scheme identifier → JS identifier. Pure, total, deterministic.
 *   run-predict  → runPredict
 *   dominates?   → dominates
 *   string->list → stringToList
 *   set-x!       → setX
 */
export function cleanName(scheme: string): string {
  let s = scheme;
  s = s.replaceAll("->", "-to-"); // string->list → string-to-list
  s = s.replaceAll(/[?!]/g, ""); // predicate? / mutate! markers carry no JS meaning
  s = s.replaceAll("*", ""); // earmuffed *globals*
  s = s.replaceAll(/[^\w-]/g, "-"); // any other punctuation → separator
  s = s.replaceAll(/[-_]+([a-z0-9])/gi, (_m, c: string) => c.toUpperCase()); // kebab/snake → camel
  s = s.replaceAll(/[-_]+$/g, ""); // trailing separators
  if (s === "") s = "_";
  if (/^\d/.test(s)) s = `_${s}`;
  if (RESERVED.has(s)) s = `${s}_`;
  return s;
}

/**
 * The friendly-name LADDER for a scheme identifier — preference-ordered JS-name
 * candidates the walker's declare pass tries in turn before falling to a `_2` postfix.
 *
 * Tier 1 is always `cleanName`. A predicate `foo?` gets a 2nd tier `isFoo` — the JS
 * boolean convention — so when `foo` is already taken the resolver picks the readable
 * `isFoo`, not `foo_2`.
 */
export function nameCandidates(scheme: string): string[] {
  const base = cleanName(scheme);
  // A predicate whose base doesn't already READ as a boolean → offer `isBase` next.
  // Skip when it already starts with a boolean verb (`hasChildren`, not `isHasChildren`).
  const reads = /^(is|has|can|should|will|was|had|are)[A-Z]/.test(base);
  if (scheme.endsWith("?") && base !== "" && base !== "_" && !reads) {
    return [base, `is${base.charAt(0).toUpperCase()}${base.slice(1)}`];
  }
  return [base];
}
