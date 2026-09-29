/**
 * Bound-name recovery — the `it` pronoun + the recovery ladder, `lexical-namer` flipped.
 *
 * A trailing-lambda's bound parameter is *semantically void*: `(lambda (e) (:family e))`
 * and `(lambda (it) (:family it))` are the same platonic lambda (α-equivalent). So we may
 * pick the most-READABLE member of the α-class — `it` when every use of the element is
 * keyed (`it[:family]` is self-documenting), a singular noun derived from the collection
 * when the element escapes opaquely (fan-out), else the original name. Every output is
 * α-equivalent to the input: **wrong is merely ugly, never incorrect** (the brace-slot
 * heuristic ban does NOT apply here — that slot carried meaning; this one does not).
 *
 * "Most readable" is a ladder; "capture-avoiding" is exactly what `@here.build/lexical-namer`
 * computes. We FLIP the forward Mercury namer (`scheme-scope.ts`, which ranks `cleanName`
 * top and the pronoun never): here `it` ranks top, the original is the collision-fallback.
 * The resolver is reused verbatim; only the strategy (the sugarcoat vocabulary — `it`, singular
 * nouns) is new.
 *
 * The gem — **anaphora IS lexical scope**. Eligible lambdas nest as the scope tree; two
 * nested all-keyed lambdas both bid `it`, and the resolver's rule *"a descendant cannot
 * reuse an ancestor's claimed name"* forces the inner one to descend — which is exactly
 * anaphoric shadowing. The nesting guard is not written; it is the resolver's semantics.
 * Sibling lambdas are independent scopes, so each freely reuses `it`.
 *
 * Two delivery modes over one mechanism (`scheme → α-renamed scheme`):
 *   - {@link tidyBoundNames}  — mode A: an explicit, committed core rewrite (prettier-like).
 *                               The renderer then needs ZERO change — it already collapses a
 *                               literal `it` trailing-lambda to `{ it … }`. Right home: the
 *                               generation pipeline (normalize machine output before store)
 *                               and an explicit "tidy" command. NEVER wire to auto-save —
 *                               silently renaming an author's `e` to `it` is a membrane leak.
 *   - {@link boundNameHints}  — mode B: a glass overlay; the source keeps `(lambda (e) …)`,
 *                               the VIEW shows the recovered name as a non-written inlay.
 *                               Right home: read-only viewing of foreign / not-yet-owned code.
 *
 * Zero-dependency-leaf invariant: arrival-sugarcoat's `.` entry is a leaf consumed by codemirror.
 * This module is the `@inhuman.tools/arrival-sugarcoat/names` SUBPATH; with `sideEffects:false`, a
 * consumer importing `.` tree-shakes this file and its `lexical-namer` import away entirely.
 * `lexical-namer` is a workspace dep with zero external deps.
 */

import { type Candidate, resolveLexicalNames, type ScopedEntity, type ScopeSpec } from "@here.build/lexical-namer";
import pluralize from "pluralize";

import { decodeAccessor, type Node, parseSexprs, printScheme } from "./sugarcoat-render.js";

// ── Node helpers (the arrival-sugarcoat parse shape) ──────────────────────────────
type AtomNode = {
  atom: string;
  str?: boolean;
  lead?: string[];
  trail?: string[];
  span?: readonly [number, number];
};
type ListNode = { list: Node[]; lead?: string[]; trail?: string[]; span?: readonly [number, number] };
const isAtom = (n: Node | undefined): n is AtomNode => n != null && "atom" in n;
const isList = (n: Node | undefined): n is ListNode => n != null && "list" in n;
const headName = (n: ListNode): string | undefined =>
  isAtom(n.list[0]) && !n.list[0].str ? n.list[0].atom : undefined;

// ── classification vocabulary ─────────────────────────────────────────────────

/** Heads that are NOT plain applications — a single-param lambda in their arg slot
 *  is a binder body / special-form clause, not an iteration callback. Mirrors the
 *  binder + control subset of sugarcoat-render's NEVER_METHOD. */
const SPECIAL_FORMS = new Set<string>([
  "quote",
  "quasiquote",
  "unquote",
  "unquote-splicing",
  "lambda",
  "named-lambda",
  "define",
  "define-values",
  "define-syntax",
  "define-record-type",
  "if",
  "cond",
  "case",
  "when",
  "unless",
  "and",
  "or",
  "begin",
  "do",
  "set!",
  "let",
  "let*",
  "letrec",
  "letrec*",
  "let-values",
  "let*-values",
  "let-syntax",
  "letrec-syntax",
  "else",
  "=>",
  "delay",
  "delay-force",
  "parameterize",
  "guard",
  "syntax-rules",
]);

/** Element-wise HOFs whose LAST argument is the collection — the rung-80 antecedent for a
 *  fan-out element. A lambda outside a recognised HOF simply has no rung-80 (falls to `it`
 *  if keyed, else the original); we never singularise a non-collection argument. */
const ELEMENT_HOFS = new Set<string>([
  "map",
  "filter",
  "for-each",
  "find",
  "find-tail",
  "remove",
  "partition",
  "count",
  "filter-map",
  "append-map",
  "take-while",
  "drop-while",
  "span",
  "break",
  "any",
  "every",
  "list-index",
  "delete",
]);

const LET_FAMILY = new Set<string>(["let", "let*", "letrec", "letrec*"]);

/** A plain identifier reference (not a string, `:keyword`, or the `<>` slot). */
const isPlainRef = (a: AtomNode): boolean =>
  !a.str && a.atom !== "<>" && !(a.atom.length > 1 && a.atom.startsWith(":"));

/** Binding names of a param list `(a b . rest)` → `["a","b","rest"]` (rest included). */
function paramNames(node: Node | undefined): string[] {
  if (!isList(node)) return [];
  const out: string[] = [];
  for (let i = 0; i < node.list.length; i++) {
    const p = node.list[i]!;
    if (isAtom(p) && p.atom === ".") {
      const rest = node.list[i + 1];
      if (isAtom(rest)) out.push(rest.atom);
      break;
    }
    if (isAtom(p)) out.push(p.atom);
    else if (isList(p) && isAtom(p.list[0])) out.push(p.list[0].atom); // (x init) → x
  }
  return out;
}

/** Binding var names of a let-bindings list `((x i) (y j))` → `["x","y"]`. */
function letVarNames(bindings: Node | undefined): string[] {
  if (!isList(bindings)) return [];
  const out: string[] = [];
  for (const b of bindings.list) if (isList(b) && isAtom(b.list[0])) out.push(b.list[0].atom);
  return out;
}

/** An eligible recovery target: a single-param `(lambda (p) body)` (arrow-shaped, one
 *  body). Multi-param lambdas can't take the `it` pronoun (≥2 antecedents) and are
 *  already explicitly named; zero-param lambdas have nothing to recover. */
function eligibleParam(lam: Node): AtomNode | null {
  if (!isList(lam) || lam.list.length !== 3 || headName(lam) !== "lambda") return null;
  const params = lam.list[1];
  if (!isList(params) || params.list.length !== 1) return null;
  const p = params.list[0];
  return isAtom(p) && !p.str ? p : null;
}

// ── §C5: keyed-vs-bare body analysis ──────────────────────────────────────────

/** A use of `param` is KEYED iff its parent form is an accessor application with the
 *  param in the receiver slot: `(:k p)`, `(c[ad]+r p)`, `(@ p k)`. Any other occurrence
 *  (head position, non-receiver arg, bare value) is BARE. `param` not occurring at all →
 *  vacuously all-keyed (a dropped param → harmless `it`). Inner binders that rebind the
 *  name are skipped (their occurrences belong to a different binding). */
function classifyParamUse(param: string, body: Node): "all-keyed" | "fan-out" {
  let bare = false;
  /** Is `(items)` an accessor app with the param as receiver? */
  const keyedReceiver = (items: Node[], idx: number): boolean => {
    if (idx !== 1) return false; // receiver slot is always arg-1
    const h = items[0];
    if (!isAtom(h) || h.str) return false;
    if (h.atom.length > 1 && h.atom.startsWith(":") && items.length === 2) return true; // (:k p)
    if (decodeAccessor(h.atom) !== null && items.length === 2) return true; // (cadr p)
    if (h.atom === "@" && items.length === 3) return true; // (@ p k)
    return false;
  };
  const walk = (n: Node): void => {
    if (bare) return;
    if (isAtom(n)) return; // bare atoms are inspected by their parent list below
    const items = n.list;
    if (items.length === 0) return;
    const hn = headName(n);
    if (hn === "quote") return; // datum — no references
    // skip inner binders that rebind the param (their refs aren't ours)
    if (hn === "lambda" && paramNames(items[1]).includes(param)) return;
    if (hn !== undefined && LET_FAMILY.has(hn)) {
      const named = isAtom(items[1]);
      const bindings = named ? items[2] : items[1];
      const vars = letVarNames(bindings);
      const loop = named && isAtom(items[1]) ? items[1].atom : undefined;
      // inits live in the enclosing scope → still ours; body skipped iff rebound.
      if (isList(bindings)) for (const b of bindings.list) if (isList(b) && b.list[1]) walk(b.list[1]);
      if (!vars.includes(param) && loop !== param) for (const c of items.slice(named ? 3 : 2)) walk(c);
      return;
    }
    for (let i = 0; i < items.length; i++) {
      const c = items[i]!;
      if (isAtom(c) && !c.str && c.atom === param) {
        if (!keyedReceiver(items, i)) bare = true;
      } else {
        walk(c);
      }
    }
  };
  walk(body);
  return bare ? "fan-out" : "all-keyed";
}

// ── capture-avoidance: free variables of a body subtree ───────────────────────

/** Identifiers referenced FREE in `node` (referenced, not bound by a binder inside
 *  `node`). Over-approximating is safe — an extra reservation only forbids a recovered
 *  name, never permits a capture; under-counting would let a rename capture, so unhandled
 *  binders simply leave their vars in (counted free). `quote` data is skipped (nothing in
 *  it is evaluated, so nothing there can be captured). */
function freeVars(node: Node): Set<string> {
  const free = new Set<string>();
  const go = (n: Node, bound: ReadonlySet<string>): void => {
    if (isAtom(n)) {
      if (isPlainRef(n) && !bound.has(n.atom)) free.add(n.atom);
      return;
    }
    const items = n.list;
    if (items.length === 0) return;
    const hn = headName(n);
    if (hn === "quote") return;
    if (hn === "lambda" && isList(items[1])) {
      const b2 = new Set(bound);
      for (const p of paramNames(items[1])) b2.add(p);
      for (const c of items.slice(2)) go(c, b2);
      return;
    }
    if (hn !== undefined && LET_FAMILY.has(hn)) {
      const named = isAtom(items[1]);
      const bindings = named ? items[2] : items[1];
      const b2 = new Set(bound);
      for (const v of letVarNames(bindings)) b2.add(v);
      if (named && isAtom(items[1])) b2.add(items[1].atom);
      // inits in the enclosing scope (over-approx: let* earlier-var refs counted free → safe)
      if (isList(bindings)) for (const b of bindings.list) if (isList(b) && b.list[1]) go(b.list[1], bound);
      for (const c of items.slice(named ? 3 : 2)) go(c, b2);
      return;
    }
    for (const c of items) go(c, bound);
  };
  go(node, new Set());
  return free;
}

// ── §C2: the HOF call collection (the rung-80 antecedent) ─────────────────────

/** The collection name threaded into an element lambda's ladder: the LAST argument of a
 *  recognised element-wise HOF call, when it's a plain symbol. Undefined otherwise. */
function collectionFor(call: ListNode): string | undefined {
  const hn = headName(call);
  if (hn === undefined || !ELEMENT_HOFS.has(hn)) return undefined;
  const last = call.list.at(-1);
  return isAtom(last) && isPlainRef(last) ? last.atom : undefined;
}

// ── the ladder (§2) ───────────────────────────────────────────────────────────

export interface TidyOptions {
  /** Collection → singular noun for the rung-80 fan-out name. Default: `pluralize.singular`
   *  — the SAME library Mercury's legibility element-namer (`arrival-mercury`'s
   *  `elementNameOf`) uses to singularize a `.map`-style receiver's collection name, so both
   *  sites derive an element noun from a collection identically. A bad singular is ugly, never
   *  incorrect — the resolver still has the original at rung 40. Injectable to override. */
  singularize?: (word: string) => string;
  /** Extra names to block everywhere (caller globals not visible in the source text). */
  reserved?: readonly string[];
}

/** §2 ladder, content-derived. all-keyed → `{100:"it", 40:original}`; fan-out with a known
 *  collection → `{80:singular, 40:original}`; fan-out without one → `{40:original}` (stays
 *  original). Rung 40 (original) is the guaranteed-unique string fallback the resolver
 *  requires. */
function ladderFor(
  paramName: string,
  body: Node,
  call: ListNode,
  singularize: (w: string) => string,
): Record<number, Candidate> {
  const rec: Record<number, Candidate> = { 40: paramName };
  if (classifyParamUse(paramName, body) === "all-keyed") {
    rec[100] = "it";
  } else {
    const coll = collectionFor(call);
    if (coll !== undefined) {
      const sing = singularize(coll);
      // Only offer rung 80 when the collection is DEMONSTRABLY plural — i.e. singularising
      // changed the name. An unchanged name is no evidence of a count-noun: `history`,
      // `matched`, `kept-v` singularise to themselves, and renaming the element to the
      // *collection's own* name ("an element of `history` is a `history`") is a mis-name.
      // The singulariser is thus also the plurality oracle; when it's silent we keep the
      // original (rung 40). `sing !== paramName` then guards the trivial no-op rename.
      if (sing && sing !== coll && sing !== paramName) rec[80] = sing;
    }
  }
  return rec;
}

// ── scope-tree assembly + resolution (the flip) ───────────────────────────────

interface Recovered {
  param: AtomNode;
  body: Node;
}

interface Analysis {
  assignments: ReadonlyMap<Node, string>;
  recovered: Recovered[];
}

/** Walk the forest into a `ScopeSpec` tree (eligible lambdas → scopes, nested by
 *  containment) and resolve. Pure — does NOT mutate the forest. */
function analyze(forest: Node[], opts: TidyOptions | undefined): Analysis {
  const singularize = opts?.singularize ?? ((w: string) => pluralize.singular(w));
  const recovered: Recovered[] = [];
  const entityId = new Map<Node, string>();
  let counter = 0;

  /** Eligible-lambda scopes found within `node`. An eligible lambda found in argument
   *  position of an application becomes a scope (its param the entity, its body's free
   *  vars the reservations, its body's eligible lambdas the children — so the anaphora
   *  shadowing falls out of the resolver's descendant-can't-reuse rule). A non-eligible
   *  intermediate is transparent: its inner eligibles attach to the current level (it
   *  claims no name, so it casts no shadow). */
  const scopesIn = (node: Node): ScopeSpec<Node>[] => {
    if (!isList(node)) return [];
    const items = node.list;
    if (items.length === 0) return [];
    const hn = headName(node);
    if (hn === "quote") return [];
    const isApp = hn !== undefined && !SPECIAL_FORMS.has(hn);
    const out: ScopeSpec<Node>[] = [];
    for (const [k, item] of items.entries()) {
      const child = item!;
      const param = isApp && k >= 1 ? eligibleParam(child) : null;
      if (param === null) {
        out.push(...scopesIn(child));
      } else {
        const lam = child as ListNode;
        const body = lam.list[2]!;
        entityId.set(param, String(counter++));
        recovered.push({ param, body });
        const entity: ScopedEntity<Node> = {
          key: param,
          candidates: ladderFor(param.atom, body, node, singularize),
        };
        // Capture-avoidance reservations = the body's free vars, MINUS the param
        // itself. The param reads as "free" in the body subtree (its binder, the
        // lambda, is one level up), but it is exactly the name we may reassign —
        // renaming it is α-renaming, not capture. Leaving it in would reserve the
        // rung-40 original and force a spurious numeric fallback (`k`→`k2`).
        const reserved = freeVars(body);
        reserved.delete(param.atom);
        out.push({
          reservations: [...reserved],
          entities: [entity],
          children: scopesIn(body),
        });
      }
    }
    return out;
  };

  const children: ScopeSpec<Node>[] = [];
  for (const form of forest) children.push(...scopesIn(form));

  const root: ScopeSpec<Node> = {
    id: "root",
    reservations: [...(opts?.reserved ?? [])],
    entities: [],
    children,
  };
  const { assignments } = resolveLexicalNames(root, {
    postfixFor: (n) => entityId.get(n) ?? "0",
    resolveTie: (name, p) => `${name}_${p}`,
    onTie: "free",
  });
  return { assignments, recovered };
}

// ── §1.1 capture-avoiding substitution (the rewrite) ──────────────────────────

/** Rename every BOUND reference to `oldName` in `body` to `newName`, skipping inner
 *  binders that rebind `oldName` (their occurrences are a different binding) and `quote`
 *  data. The param's own binding occurrence is renamed by the caller. */
function renameBoundRefs(body: Node, oldName: string, newName: string): void {
  const go = (n: Node): void => {
    if (isAtom(n)) {
      if (!n.str && n.atom === oldName) n.atom = newName;
      return;
    }
    const items = n.list;
    if (items.length === 0) return;
    const hn = headName(n);
    if (hn === "quote") return;
    if (hn === "lambda" && isList(items[1]) && paramNames(items[1]).includes(oldName)) return; // shadowed
    if (hn !== undefined && LET_FAMILY.has(hn)) {
      const named = isAtom(items[1]);
      const bindings = named ? items[2] : items[1];
      const vars = letVarNames(bindings);
      const loop = named && isAtom(items[1]) ? items[1].atom : undefined;
      if (isList(bindings)) for (const b of bindings.list) if (isList(b) && b.list[1]) go(b.list[1]); // inits
      if (!vars.includes(oldName) && loop !== oldName) for (const c of items.slice(named ? 3 : 2)) go(c);
      return;
    }
    for (const c of items) go(c);
  };
  go(body);
}

// ── public API ────────────────────────────────────────────────────────────────

/** Mode A — an explicit, committed normalize pass: `scheme → α-renamed scheme`. Every
 *  recovered trailing-lambda parameter becomes `it` / a singular noun / its original. The
 *  renderer then collapses a literal-`it` trailing lambda to `{ it … }` with no change.
 *
 *  NOT for auto-save: this renames author-chosen names. Right home is the generation
 *  pipeline (normalise machine output before store) and an explicit "tidy" command.
 *
 *  Comments are not preserved (printScheme is the canonical Scheme writer) — fine for
 *  generated output; hand-authored / foreign code should use {@link boundNameHints}. */
export function tidyBoundNames(scheme: string, opts?: TidyOptions): string {
  const forest = parseSexprs(scheme);
  const { assignments, recovered } = analyze(forest, opts);
  for (const { param, body } of recovered) {
    const name = assignments.get(param);
    if (name !== undefined && name !== param.atom) {
      const old = param.atom;
      param.atom = name;
      renameBoundRefs(body, old, name);
    }
  }
  return forest.map((f) => printScheme(f)).join("\n\n");
}

export interface BoundNameHint {
  /** Char offset of the parameter's binding occurrence; the inlay renders there. */
  pos: number;
  /** The recovered name (`it` / singular noun). */
  name: string;
}

/** Mode B — a glass overlay: the source keeps `(lambda (e) …)`; the VIEW shows the
 *  recovered name as a non-written inlay at each recovered parameter's binding site.
 *  Mirrors `param-hints.ts`. Returns `[]` on a parse error (mid-edit buffer → no hints,
 *  never throws). Right home: read-only viewing of foreign / not-yet-owned code, where
 *  committing the rename would be a membrane leak. */
export function boundNameHints(scheme: string, opts?: TidyOptions): BoundNameHint[] {
  let forest: Node[];
  try {
    forest = parseSexprs(scheme);
  } catch {
    return [];
  }
  const { assignments, recovered } = analyze(forest, opts);
  const hints: BoundNameHint[] = [];
  for (const { param } of recovered) {
    const name = assignments.get(param);
    if (name !== undefined && name !== param.atom && param.span) hints.push({ pos: param.span[0], name });
  }
  return hints;
}
