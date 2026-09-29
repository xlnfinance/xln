/**
 * trace → candidate-box forest: the bridge from a real EvalTrace to the
 * laminar forest the MDL collapse optimizer consumes (`mdl-collapse.ts`).
 *
 * The trace records EVERY Pair invocation, ~80% of which is stdlib plumbing
 * (`list`/`cons`/`apply`/`if`/`null?`/`car`/…, including a map's own internal
 * machinery). The forest must filter to MEANINGFUL scopes and re-parent their
 * children *through* the plumbing. Meaningful (the chosen box vocabulary,
 * scheme "A" + promotable defines):
 *   - provenance points (infer/query) — repeated `leaf` boxes
 *   - recognized control forms — map/filter/for-each (unfold), reduce/fold
 *     (fold), cond/case/when/unless (dnf)
 *   - self-recursion — the BODY of a self-recursive function (loop), ×K iters
 *   - promoted user `define`s — opted-in via `opts.promoted` (suggested/forced)
 * User function calls are otherwise TRANSPARENT (their children re-parent up).
 *
 * Multiplicity uses MEASURED occurrence counts, not per-level products: a box's
 * `n = occurrences / parent-occurrences`. This telescopes (ancestorMult·n =
 * measured occurrences) so conditionals (a node that ran 2 of 3 loop iters) and
 * self-recursion fall out correctly — no integer-multiplicity assumption. (The
 * ×N *display* badge should use measured occurrences; `n` here is the cost-math
 * ratio and may be fractional for conditional scopes.)
 *
 * Ids are STRUCTURAL (`head@line:col`) so the layout is stable across runs
 * (for stability) — not derived from iteration order.
 *
 * v1 approximations (documented, not hidden):
 *   - `localBits` is a proxy (count of a representative instance's immediate
 *     plumbing children); `distinctShapes` defaults to 1 (structural shape-class
 *     detection across instances is the next step).
 *   - Loop bodies nest correctly: the loop box is the recursive function's BODY
 *     scope — entered ×K, including the first call — so the per-iteration work
 *     nests under one box (see the loop-detection comment below).
 *   - Accessor macros (`field`/`@`) expand to a `cond` the classifier currently
 *     sees as a dnf box (minor noise; refine by skipping macro-internal forms).
 */
import { headOf, scopeId, snapshotTrace, type PlainInv, type EvalTrace } from "@inhuman.tools/arrival/provenance";

// scopeId lives in a cycle-neutral leaf (scope-id.ts) — trace-snapshot needs it too, and
// trace-to-forest imports trace-snapshot, so a reverse import would close a loop. Re-exported
// here so downstream `from "./trace-to-forest.js"` importers keep the same surface.

// CandidateBox/BoxType describe the forest's own vocabulary (the candidate boxes
// this module produces for the MDL collapse optimizer to decide over) — they live
// here, not in mdl-collapse.ts, so the primitive layer (this file) doesn't type-import
// from the analysis layer (mdl-collapse.ts). mdl-collapse.ts imports them back.
export type BoxType = "unfold" | "loop" | "dnf" | "fold" | "leaf";

/** A collapse/expand verdict for a candidate box — the shape `CandidateBox.force`
 *  references and the MDL optimizer (`mdl-collapse.ts`) emits. Lives here (the
 *  structural/primitive layer) so the forest types own it without importing the
 *  analysis layer. */
export type Decision = "collapsed" | "expanded";

export interface CandidateBox {
  id: string;
  type: BoxType;
  /** Trace multiplicity: iterations (loop), fan-out width (unfold), arms (dnf). */
  n: number;
  /** Description bits of this scope's OWN body structure, excluding children. */
  localBits: number;
  /** External bindings the box connects to — encoded once in the definition AND
   *  per reference (the residual identification cost AST-licensing does NOT make
   *  free). Default 0. */
  boundaryPorts?: number;
  /** Number of DISTINCT structural sub-DAG shapes across the n instances. 1 ⇒
   *  uniform (collapse is residual-free). k>1 ⇒ a collapsed box must encode a
   *  per-instance shape selector (log2 k bits each) — the grammar-derivation
   *  residual, kept STRUCTURAL (topology) so the layout stays value-stable.
   *  Default 1. */
  distinctShapes?: number;
  /** Override the MDL decision (marks-as-override). Unset ⇒
   *  the optimizer decides ("suggested"). `"collapsed"` ⇒ always a box
   *  ("forced", e.g. a promoted user-define). `"expanded"` ⇒ always flattened
   *  (force-suppress a box the MDL wanted). The human's deliberate disagreement
   *  with the optimizer, honored. */
  force?: Decision;
  children: CandidateBox[];
}

const CONTROL_TYPE: Record<string, BoxType> = {
  map: "unfold",
  filter: "unfold",
  "for-each": "unfold",
  reduce: "fold",
  fold: "fold",
  "fold-left": "fold",
  "fold-right": "fold",
  cond: "dnf",
  case: "dnf",
  when: "dnf",
  unless: "dnf",
};

/** Non-control special forms — binding/sequencing/branching machinery that is
 *  never a user box, and (crucially) must be excluded from loop detection: a
 *  recursive function's body re-enters its `let`/`if`/`begin` every iteration,
 *  so "any same-Pair ancestor" would mistake those for loops. A loop is a
 *  recursive APPLICATION, not a special form. (cond/case/when/unless are NOT
 *  here — they're dnf control forms.) */
export const STRUCTURAL_FORMS = new Set([
  "let",
  "let*",
  "letrec",
  "if",
  "begin",
  "lambda",
  "define",
  "and",
  "or",
  "quote",
  "quasiquote",
  "set!",
]);

// ── Static tail-recursion detection ──────────────────────────────────────────
// `hasSelfAncestor` can only call a function a loop AFTER it has recursed at least
// once — which, when the recursive arg is an async `(infer …)`, is not until the
// CURRENT iteration finishes. So a streaming loop renders with no container until
// its successor fires, then snaps into one (for stability: the structure
// must not reshape mid-run). The fix is static: a function whose body tail-calls
// ITSELF is a loop the moment it's defined — knowable from the AST, before any
// iteration runs. We read it straight off the `(define …)` forms in the trace.

interface PairLike {
  car: unknown;
  cdr: unknown;
}
const isPair = (v: unknown): v is PairLike => v !== null && typeof v === "object" && "car" in v && "cdr" in v;
const symName = (v: unknown): string | null =>
  v !== null && typeof v === "object" && "__name__" in v && typeof (v as { __name__: unknown }).__name__ === "string"
    ? (v as { __name__: string }).__name__
    : null;
/** Proper-list elements of a Pair chain (stops at a non-pair cdr). */
const listOf = (p: unknown): unknown[] => {
  const out: unknown[] = [];
  for (let cur = p; isPair(cur); cur = cur.cdr) out.push(cur.car);
  return out;
};

/** Does `form`, evaluated in tail position, tail-call `fname`? Walks only the tail
 *  arms of the structural forms (R7RS §3.5): the chosen-arm of `if`/`cond`, the
 *  last form of `begin`/`let*`/`when`/`and`/…; a bare application in tail position
 *  is a self-call iff its head is `fname`. Non-tail sub-positions are irrelevant —
 *  a self-call there grows the stack but is still detected dynamically. */
function tailCallsSelf(form: unknown, fname: string): boolean {
  if (!isPair(form)) return false;
  const items = listOf(form);
  const head = symName(form.car);
  const last = (xs: unknown[]): boolean => xs.length > 0 && tailCallsSelf(xs.at(-1), fname);
  switch (head) {
    case "if": // (if c then else) — both arms are tail
      return tailCallsSelf(items[2], fname) || tailCallsSelf(items[3], fname);
    case "cond": // each clause's last expr is tail
      return items.slice(1).some((cl) => last(listOf(cl)));
    case "case": // (case key (datums expr…)…) — each clause body's last is tail
      return items.slice(2).some((cl) => last(listOf(cl).slice(1)));
    case "begin":
    case "when":
    case "unless":
    case "and":
    case "or":
      return last(items.slice(1));
    case "let":
    case "let*":
    case "letrec": // (let [name] bindings body…) — the LAST body form is tail
      return last(items);
    default:
      return head === fname; // a tail-position application of the function itself
  }
}

/** Reads a `(define …)` invocation into `{ fname, body }` for both shapes:
 *  `(define (f …) body…)` → the signature's head + the rest as body forms;
 *  `(define f (lambda (…) body…))` → the target + the lambda's body forms.
 *  Returns null for anything that isn't a function define. */
function defineShape(node: unknown): { fname: string; body: unknown[] } | null {
  if (headOf(node) !== "define") return null;
  const [, target, ...rest] = listOf(node);
  if (isPair(target)) {
    const fname = symName(target.car);
    return fname ? { fname, body: rest } : null;
  }
  const fname = symName(target);
  if (fname && isPair(rest[0]) && symName((rest[0] as PairLike).car) === "lambda") {
    return { fname, body: listOf(rest[0]).slice(2) };
  }
  return null;
}

/** The function names whose `(define …)` body statically tail-recurses — loops
 *  recognizable before they've run a single iteration. */
export function staticRecursiveHeads(invs: PlainInv[]): Set<string> {
  const heads = new Set<string>();
  for (const inv of invs) {
    const d = defineShape(inv.node);
    if (d && d.body.length > 0 && tailCallsSelf(d.body.at(-1), d.fname)) heads.add(d.fname);
  }
  return heads;
}

/** The exact body-form Pairs of statically-recursive functions — the scopes a loop
 *  re-enters each iteration. This is the PRECISE loop-body set: unlike "any child
 *  of a recursive-head call" (which also catches the recursive call's ARGUMENT
 *  evaluations, e.g. `(loop (next x) …)`'s `(next x)`), the body Pair is exactly
 *  what the function evaluates per call, shared by identity across every iteration
 *  INCLUDING the first. The evaluator runs the literal body Pair from the source,
 *  so its runtime invocation node is identity-equal to these AST Pairs. */
export function staticLoopBodyScopes(invs: PlainInv[]): Set<object> {
  const scopes = new Set<object>();
  for (const inv of invs) {
    const d = defineShape(inv.node);
    if (!d || d.body.length === 0 || !tailCallsSelf(d.body.at(-1), d.fname)) continue;
    for (const form of d.body) if (form !== null && typeof form === "object") scopes.add(form as object);
  }
  return scopes;
}

export interface ForestOptions {
  /** User-define scopes promoted to boxes: head name → mode. "suggested" enters
   *  as a normal MDL candidate; "forced" pins it collapsed (force-override). */
  promoted?: Map<string, "suggested" | "forced">;
}

export function traceToForest(trace: EvalTrace, opts: ForestOptions = {}): CandidateBox[] {
  const promoted = opts.promoted ?? new Map<string, "suggested" | "forced">();

  // Snapshot the live trace once; the classification passes below then walk
  // plain parent/children/node refs on an immutable copy. Signature unchanged.
  const all: PlainInv[] = snapshotTrace(trace).invocations;

  // A loop = a self-recursive function. We box its BODY (the lambda-body scope,
  // entered once per iteration — INCLUDING the first, top-level call), NOT the
  // recursive call-site. The body Pair telescopes all K iterations into one ×K
  // box and the per-iteration work (map / infer / …) nests under it; boxing the
  // call-site instead would fire only K−1 times and orphan the first iteration's
  // body at root (the trace shape: `loop`-call ⊃ `let`-body ⊃ {work, `if` ⊃
  // recursive `loop`-call ⊃ `let`-body ⊃ …}).
  //
  // Two steps:
  //  1. recursive functions — a (non-structural) APPLICATION whose Pair recurs on
  //     its own ancestor chain; its head names the recursive function.
  //  2. loop bodies — a re-entrant scope whose PARENT is a recursive-function
  //     application (the form that function evaluates each call). The first,
  //     top-level body entry isn't itself re-entrant but shares the body Pair, so
  //     it joins the same box via grouping. Works for tail- AND stack-recursion
  //     (the body Pair is entered K times either way; multiplicity collapses it).
  const hasSelfAncestor = (inv: PlainInv): boolean => {
    for (let p = inv.parent; p; p = p.parent) if (p.node === inv.node) return true;
    return false;
  };
  // Recursive-function heads come from TWO sources, unioned: the static AST scan
  // (`staticRecursiveHeads`) knows a function loops the moment it's defined — so a
  // streaming loop boxes from iteration 0, before its successor fires; the dynamic
  // `hasSelfAncestor` scan catches anything the static reader misses (e.g. mutual
  // recursion, or a loop the define-form heuristic doesn't match).
  const recursiveFnHeads = staticRecursiveHeads(all);
  for (const inv of all) {
    if (STRUCTURAL_FORMS.has(headOf(inv.node))) continue;
    if (hasSelfAncestor(inv)) recursiveFnHeads.add(headOf(inv.node));
  }
  // Loop body scopes, two sources. The STATIC set is the exact body Pairs of
  // statically-recursive defines — present from iteration 0 (box midway, not only
  // on completion) without mis-tagging the recursive call's argument evaluations.
  // The DYNAMIC rule (parent is a recursive call AND the body re-entered) covers
  // loops the static reader can't see (mutual recursion).
  const loopScopes = staticLoopBodyScopes(all);
  for (const inv of all) {
    if (inv.parent && hasSelfAncestor(inv) && recursiveFnHeads.has(headOf(inv.parent.node))) {
      loopScopes.add(inv.node as object);
    }
  }

  const meaningful = (inv: PlainInv): boolean =>
    inv.isProvenancePoint ||
    headOf(inv.node) in CONTROL_TYPE ||
    promoted.has(headOf(inv.node)) ||
    loopScopes.has(inv.node as object);

  // Box-parent: nearest ancestor that is meaningful AND a DIFFERENT scope —
  // skipping same-scope ancestors collapses self-recursion into one loop box.
  const boxParent = (inv: PlainInv): object | null => {
    for (let p = inv.parent; p; p = p.parent) {
      if (meaningful(p) && p.node !== inv.node) return p.node as object;
    }
    return null;
  };

  // Group meaningful invocations by scope (Pair identity).
  const groups = new Map<object, PlainInv[]>();
  for (const inv of all) {
    if (!meaningful(inv)) continue;
    const g = groups.get(inv.node as object);
    if (g) g.push(inv);
    else groups.set(inv.node as object, [inv]);
  }

  const occ = (scope: object): number => groups.get(scope)?.length ?? 0;
  const parentOf = new Map<object, object | null>();
  for (const [scope, invs] of groups) parentOf.set(scope, boxParent(invs[0]!));

  // Build a box per scope.
  const boxes = new Map<object, CandidateBox>();
  for (const [scope, invs] of groups) {
    const rep = invs[0]!;
    const head = headOf(scope);
    const type: BoxType = loopScopes.has(scope) ? "loop" : (CONTROL_TYPE[head] ?? "leaf");
    const mode = promoted.get(head);
    boxes.set(scope, {
      id: scopeId(scope),
      type,
      n: 1, // filled below once parent occurrences are known
      localBits: 1 + rep.children.filter((c) => !meaningful(c)).length,
      distinctShapes: 1,
      ...(mode === "forced" ? { force: "collapsed" as const } : {}),
      children: [],
    });
  }

  // Wire nesting and multiplicity (n = occurrences / parent-occurrences).
  const roots: CandidateBox[] = [];
  for (const [scope, box] of boxes) {
    const ps = parentOf.get(scope) ?? null;
    const parentOcc = ps ? occ(ps) : 1;
    box.n = occ(scope) / (parentOcc || 1);
    const parentBox = ps ? boxes.get(ps) : undefined;
    if (parentBox) parentBox.children.push(box);
    else roots.push(box);
  }
  return roots;
}
