/**
 * CARRIER CORE — lineage data model + static chunk classifier.
 * Pre-execution lens: docs/static-plane.md §THE FOUR READERS 4.4
 * (docs/PROVENANCE.md owns runtime stamp/trace/replay — cross-link, don't duplicate).
 *
 * Provenance is a static lineage TREE (pipe / merge / fan / mux), minted only at
 * Rosetta crossings. Shape is derivable from the parsed AST before execution
 * (operand-arity over non-literal operands). Runtime only stamps Rosetta leaf-ids
 * into skeleton slots. One tree answers full-cone (every leaf) and demand-cone
 * (e.g. count prunes a length-preserving fan).
 *
 * Operates on reader AST (Pair / SchemeSymbol); `classify` never evaluates.
 *
 * SPECIAL FORMS — surface Pairs from SPECIAL_FORMS (never macro-expanded):
 *   - `if` → mux(selector=test, arms=[then, else?])
 *   - `cond` → mux over clauses (`else` arm; `=>` threads test cone into arm)
 *   - `let`/`let*`/`letrec` → transparent: body under subst of each binding's
 *     classify(RHS). Sequential forms thread left-to-right; named let is recursive
 *     (`binder{cycles:true}`, not transparent)
 *   - `begin` → last expression only
 *   - `and`/`or` → value-select: union of operand cones, no predicate-taint
 *     (static over-approx; runtime stays sequential short-circuit)
 *   - `lambda` literal → no provenance at definition site
 *
 * MUX CONSERVATIVE NARROWING (docs/static-plane.md §CONSERVATIVE NARROWING):
 * cone = selector ∪ arms (taken arm unknowable statically). Always over-attribute:
 * reported origin is a SUPERSET of the true one. Control-flow "why"
 * (predicate-taint, failed-clause non-leak) is eager via evaluator wrappers —
 * this classifier owes shape, not a runtime taken-arm protocol.
 *
 * Surface special forms never enter the tagless algebra; matching Pairs is
 * cheaper than a surface→tagless compiler that would only duplicate SPECIAL_FORMS.
 * An adjoint-table reinterpretation waits on per-op adjoint rules; `walk()` is
 * already the backward pass.
 */
import { ASymbol } from "../values/primitives/ASymbol.js";
import { APair } from "../values/primitives/APair.js";
import { AValue } from "../values/primitives/AValue.js";
import type { SchemeValue } from "../values/types.js";

/** Exhaustiveness helper for LineageNode walkers — shared by sibling modules. */
export function assertNever(x: never): never {
  throw new Error(`unhandled LineageNode kind: ${JSON.stringify(x)}`);
}

/**
 * Canonical member-read step (where-provenance). All surface accessors
 * (`(:foo x)` / `(@ x :foo)` / `(car x)` / `(vector-ref x i)`) normalize here so
 * uneval targets minimal scheme. Carrier is SOLE home of the dropped key —
 * `(:field x)` forwards the producer's point; runtime field-point carries no key.
 *
 * Keyword vs positional is one flat union by design: keyword wins a chain,
 * positionals are transparent — resolved at classify by absorption + `stepKey`,
 * not carried as separate kinds.
 */
export type PathStep =
  | { readonly field: string } // a named key — (:foo x) / (@ x :foo): step = {field:"foo"}
  | { readonly car: true } // the head of a pair — (car x)
  | { readonly index: number }; // a positional index — (vector-ref x i) / (list-ref x i), i a LITERAL int

/** Static lineage skeleton. Runtime fills leaf/source slots with stamp sets. */
export type LineageNode =
  | { readonly kind: "literal" } // self-evaluating / lambda — never carries provenance
  | { readonly kind: "leaf"; readonly slot: string }
  | { readonly kind: "source"; readonly op: string } // Rosetta-in mint
  | { readonly kind: "pipe"; readonly op: string; readonly child: LineageNode } // ≤1 prov input
  | { readonly kind: "merge"; readonly op: string; readonly children: readonly LineageNode[] } // ≥2 fan-in
  // Where-provenance lens: walk descends FOCUSED child only (siblings pruned at classify).
  | { readonly kind: "field"; readonly op: string; readonly step: PathStep; readonly child: LineageNode }
  // map/filter. `lengthPreserving` gates count-cone prune. `template` (lambda body)
  // is fan×lens structure for composition — walk never descends it (cone from
  // source+introduces only).
  | {
      readonly kind: "fan";
      readonly op: string;
      readonly introduces: boolean;
      readonly lengthPreserving: boolean;
      readonly source: LineageNode;
      readonly template?: LineageNode;
    }
  // if/cond — cone = selector ∪ arms (conservative).
  | { readonly kind: "mux"; readonly op: string; readonly selector: LineageNode; readonly arms: readonly LineageNode[] }
  | { readonly kind: "opaque"; readonly op: string; readonly children: readonly LineageNode[] }
  // Sink: port with no egress. Children still matter (I1 confinement); contributes no mint of its own.
  | { readonly kind: "sink"; readonly op: string; readonly children: readonly LineageNode[] }
  // Membrane crossing that neither mints nor stamps. Cone-identical to pipe; distinct graph fact.
  | { readonly kind: "transparent"; readonly op: string; readonly child: LineageNode }
  // Binder. `cycles: true` = named-let / do / declared loop. Children = flat barrier
  // (bindings+body); deferred: real backedge topology / per-iteration attribution.
  | {
      readonly kind: "binder";
      readonly op: string;
      readonly cycles: boolean;
      readonly children: readonly LineageNode[];
    };

/** Declared-role vocabulary, local union (not imported from `_bake.ts`) so this
 *  module stays value-guards+primitives only. Must stay lock-step with
 *  `ProvenanceRole` in common/symbols. */
export type DeclaredRole = "pipe" | "fan" | "source" | "sink" | "transparent" | "loop" | "opaque";

/**
 * Operator roles from DECLARATION only — never guessed from name or duck-read
 * off bound functions. Production: env callable's `.provenanceRole`
 * (`lineage-classifier-from-env.ts`). `undefined` ≡ explicit `"pipe"` (unbound,
 * plain lambda, or unmodeled special-form head).
 */
export interface Classifier {
  roleOf(op: string): DeclaredRole | undefined;
}

function opName(x: unknown): string {
  const v = (x as { valueOf?: () => unknown })?.valueOf?.();
  return typeof v === "string" || typeof v === "symbol" ? String(v) : String(x);
}

/**
 * Special forms `classify` models by shape (switch in classifyWith). Live env
 * resolves them as SPECIAL_FORMS macros — consumers that skip "macro heads" must
 * EXCLUDE these. Keep this set lock-step with that switch.
 *
 * Not exhaustive over SPECIAL_FORMS: unmodeled heads (`case`/`while`/`quasiquote`/…)
 * fall through as applications (mis-modeled by shape). `do` → `binder{cycles:true}`
 * via `classifyDo`.
 */
export const CLASSIFIED_SPECIAL_FORMS: ReadonlySet<string> = new Set([
  "if",
  "cond",
  "let",
  "let*",
  "letrec",
  "letrec*",
  "begin",
  "when",
  "unless",
  "and",
  "or",
  "lambda",
  "quote",
  "do",
]);

const isSym = (x: unknown, name: string): boolean => x instanceof ASymbol && opName(x) === name;

function isLiteral(x: unknown): boolean {
  return !(x instanceof ASymbol) && !(x instanceof APair);
}

// Pair slots are `unknown`; narrow by guard. `SchemeValue` over-claims reader slots.
function operands(app: APair<any, any>): unknown[] {
  const out: unknown[] = [];
  let n: unknown = app.cdr;
  while (n instanceof APair) {
    out.push(n.car);
    n = n.cdr;
  }
  return out;
}

const isProvBearing = (n: LineageNode): boolean => n.kind !== "literal";

/** A LITERAL integer datum's value (`(vector-ref x 1)` → `1`), else null. The
 *  index must be a self-evaluating exact integer; a variable index (`(vector-ref
 *  x n)`) leaves the form a plain op (no static field — the key isn't known). */
function literalIndex(x: unknown): number | null {
  if (x instanceof ASymbol || x instanceof APair) return null;
  const v = (x as { valueOf?: () => unknown })?.valueOf?.();
  return typeof v === "number" && Number.isInteger(v) ? v : null;
}

/**
 * Member-read → canonical step + projected arg, else null. Surfaces:
 *   - `(:foo x)` → {field:"foo"}
 *   - `(@ x :foo)` / `(@ x "foo")` / literal index key
 *   - `(car x)` → {car:true}
 *   - `(vector-ref|list-ref x i)` with literal int i → {index:i}
 * Emitting one node shape is what makes field-pin agreement possible without lookahead.
 */
function memberRead(head: unknown, args: unknown[]): { step: PathStep; argExpr: unknown } | null {
  if (!(head instanceof ASymbol)) return null;
  const name = opName(head);

  // (:foo x) — keyword accessor. Head is `:foo`; a bare `:` (no field) is not one.
  if (name.length > 1 && name.startsWith(":") && args.length > 0) {
    return { step: { field: name.slice(1) }, argExpr: args[0] };
  }

  // (@ x :foo) / (@ x "foo") — membrane member-read; same canonical step. The key
  // is the SECOND operand: a `:foo` keyword symbol, a "foo" string, or a literal int.
  if (name === "@" && args.length >= 2) {
    const key = args[1];
    const keyName = key instanceof ASymbol ? opName(key) : null;
    if (keyName !== null && keyName.length > 1 && keyName.startsWith(":")) {
      return { step: { field: keyName.slice(1) }, argExpr: args[0] };
    }
    if (!(key instanceof ASymbol) && !(key instanceof APair)) {
      const kv = (key as { valueOf?: () => unknown })?.valueOf?.();
      if (typeof kv === "string") return { step: { field: kv }, argExpr: args[0] };
      const ki = literalIndex(key);
      if (ki !== null) return { step: { index: ki }, argExpr: args[0] };
    }
    return null; // computed key (`(@ x k)`) — not a static field
  }

  if (name === "car" && args.length > 0) return { step: { car: true }, argExpr: args[0] };

  if ((name === "vector-ref" || name === "list-ref") && args.length >= 2) {
    const i = literalIndex(args[1]);
    if (i !== null) return { step: { index: i }, argExpr: args[0] };
  }

  return null;
}

/** Pull the parameter symbols out of a lambda's formal list — `(it)` → ["it"],
 *  `(a b)` → ["a","b"]. A variadic/rest tail (`(a . r)`, or a bare symbol formal)
 *  is ignored for binding (the element flows in via the leading positionals only).*/
function lambdaParams(formals: unknown): string[] {
  const out: string[] = [];
  let n: unknown = formals;
  while (n instanceof APair) {
    if (n.car instanceof ASymbol) out.push(opName(n.car));
    n = n.cdr;
  }
  return out;
}

/**
 * Build a fan's per-element TEMPLATE when its function is a `(lambda (p…) body)`:
 * classify the body with each param bound to an ELEMENT leaf (`leaf{slot: p}`), so
 * a field projected inside the body nests under the fan (the fan×lens parametric
 * path). Returns undefined for a bare function symbol / non-lambda — those keep the
 * template-less fan. The template is a viz-/carrier-shaping structure; walk() never
 * descends it (cone neutrality).
 */
function classifyFanTemplate(fn: unknown, c: Classifier, subst: Subst): LineageNode | undefined {
  if (!(fn instanceof APair) || !isSym(fn.car, "lambda")) return undefined;
  const afterKw = fn.cdr;
  if (!(afterKw instanceof APair)) return undefined;
  const params = lambdaParams(afterKw.car);
  const bodyForms = afterKw.cdr; // (body…) — classify the LAST (begin pass-through)
  // The element binds the params as leaves; the surrounding subst still applies to
  // free vars captured from the enclosing scope (e.g. an outer `let`-bound source).
  const extended = new Map(subst);
  for (const p of params) extended.set(p, { kind: "leaf", slot: p });
  return classifyBegin(bodyForms, c, extended);
}

/**
 * Pipe-vs-merge arity cut: drop non-bearing, singleton → pipe, ≥2 → merge.
 * Static node count, not runtime set identity: two operands that resolve to the
 * SAME set still merge here (runtime would forward). fullCone equal either way;
 * fieldCone hits the demand barrier conservatively — over-approx, never under.
 */
function combine(op: string, nodes: readonly LineageNode[]): LineageNode {
  const bearing = nodes.filter(isProvBearing);
  if (bearing.length === 0) return { kind: "literal" };
  if (bearing.length === 1) return { kind: "pipe", op, child: bearing[0] };
  return { kind: "merge", op, children: bearing };
}

/** Let-family transparency: bound symbol → classify(RHS). Wireframe builder
 *  threads its let-walk subst so selectors resolve through bindings. */
export type Subst = ReadonlyMap<string, LineageNode>;
const NO_SUBST: Subst = new Map();

/**
 * Static lineage skeleton from AST — no evaluation. Pipe/merge by bearing-operand
 * count; special forms by shape (file header). Optional `subst` seeds let
 * transparency from outside (wireframe selector reachability).
 */
export function classify(ast: SchemeValue, c: Classifier, subst: Subst = NO_SUBST): LineageNode {
  return classifyWith(ast, c, subst);
}

function classifyWith(ast: unknown, c: Classifier, subst: Subst): LineageNode {
  if (isLiteral(ast)) return { kind: "literal" };
  if (ast instanceof ASymbol) {
    const slot = opName(ast);
    return subst.get(slot) ?? { kind: "leaf", slot };
  }

  const head = (ast as APair<any, any>).car;

  if (head instanceof ASymbol) {
    const form = opName(head);
    const rest = (ast as APair<any, any>).cdr;
    switch (form) {
      case "if":
        return classifyIf(rest, c, subst);
      case "cond":
        return classifyCond(rest, c, subst);
      case "let":
      case "let*":
      case "letrec":
      case "letrec*":
        return classifyLet(rest, c, subst, form !== "let");
      case "begin":
        return classifyBegin(rest, c, subst);
      case "when":
      case "unless":
        return classifyGuardedBody(rest, c, subst, form);
      case "and":
      case "or":
        // Value-select: union of operand cones, no predicate-taint.
        return combine(
          form,
          operands(ast as APair<any, any>).map((a) => classifyWith(a, c, subst)),
        );
      case "lambda":
        return { kind: "literal" };
      case "quote":
        return { kind: "literal" };
      case "do":
        return classifyDo(rest, c, subst);
      default:
        break;
    }
  }

  // Application. Computed operator `((f a) b)` stringifies via opName (HOF hole).
  const op = opName(head);
  const args = operands(ast as APair<any, any>);

  // Where-provenance before role dispatch so projection heads aren't pure ops.
  // cdr/cadr/rest stay pipes (over-approx — consumers pin keyword/car/index only).
  const projected = memberRead(head, args);
  if (projected !== null) {
    const child = classifyWith(projected.argExpr, c, subst);
    // Absorption: field-under-field keeps base + ONE step (no composed path).
    // Keyword-priority: runtime `accessorField` sees only keyword heads, so
    // `(:verdict (car x))` → {field:"verdict"}, not {car}.
    if (child.kind === "field") {
      const innerIsKeyword = "field" in child.step;
      const outerIsKeyword = "field" in projected.step;
      if (innerIsKeyword) return child;
      if (outerIsKeyword) return { kind: "field", op, step: projected.step, child };
      return child;
    }
    return { kind: "field", op, step: projected.step, child };
  }

  const role = c.roleOf(op);

  if (role === "source") return { kind: "source", op };

  if (role === "fan") {
    const fn = args[0];
    const fanOp = opName(fn);
    const lengthPreserving = op === "map" || op === "vector-map";
    const template = classifyFanTemplate(fn, c, subst);
    return {
      kind: "fan",
      op: fanOp,
      introduces: c.roleOf(fanOp) === "source",
      lengthPreserving,
      source: classifyWith(args[1], c, subst),
      // eslint-disable-next-line unicorn/no-negated-condition -- omit template when the fan has none
      ...(template !== undefined ? { template } : {}),
    };
  }

  if (role === "sink") {
    const children = args.map((a) => classifyWith(a, c, subst)).filter(isProvBearing);
    return { kind: "sink", op, children };
  }

  if (role === "transparent") {
    const combined = combine(
      op,
      args.map((a) => classifyWith(a, c, subst)),
    );
    return isProvBearing(combined) ? { kind: "transparent", op, child: combined } : combined;
  }

  if (role === "loop") {
    // Same binder shape as named-let / do special forms.
    const children = args.map((a) => classifyWith(a, c, subst)).filter(isProvBearing);
    return { kind: "binder", op, cycles: true, children };
  }

  if (role === "opaque") {
    const children = args.map((a) => classifyWith(a, c, subst)).filter(isProvBearing);
    return { kind: "opaque", op, children };
  }

  // pipe or undefined → pure-application default.
  return combine(
    op,
    args.map((a) => classifyWith(a, c, subst)),
  );
}

function classifyIf(rest: unknown, c: Classifier, subst: Subst): LineageNode {
  if (!(rest instanceof APair)) return { kind: "literal" };
  const test = rest.car;
  const afterTest = rest.cdr;
  const then_ = afterTest instanceof APair ? afterTest.car : undefined;
  const elseRest = afterTest instanceof APair ? afterTest.cdr : undefined;
  const else_ = elseRest instanceof APair ? elseRest.car : undefined;
  const arms = [then_, else_].filter((a) => a !== undefined).map((a) => classifyWith(a, c, subst));
  return { kind: "mux", op: "if", selector: classifyWith(test, c, subst), arms };
}

/** `(when/unless test body…)` ≡ a one-armed `if` over `(begin body…)`. */
function classifyGuardedBody(rest: unknown, c: Classifier, subst: Subst, op: string): LineageNode {
  if (!(rest instanceof APair)) return { kind: "literal" };
  const test = rest.car;
  const body = classifyBegin(rest.cdr, c, subst);
  return { kind: "mux", op, selector: classifyWith(test, c, subst), arms: [body] };
}

/**
 * `(cond …)` → mux: selector = union of tests; arms = bodies. `else` is a plain
 * arm; `(test => proc)` unions proc cone with test cone. Cone = selector ∪ arms
 * (matched-clause-only "why" is eager, not here).
 */
function classifyCond(rest: unknown, c: Classifier, subst: Subst): LineageNode {
  const tests: LineageNode[] = [];
  const arms: LineageNode[] = [];
  let node: unknown = rest;
  while (node instanceof APair) {
    const clause = node.car;
    node = node.cdr;
    if (!(clause instanceof APair)) continue;
    const test = clause.car;
    const body = clause.cdr;

    if (isSym(test, "else")) {
      arms.push(classifyBegin(body, c, subst)); // else: no selector, the body is the value
      continue;
    }

    const testNode = classifyWith(test, c, subst);
    tests.push(testNode);

    if (body instanceof APair && isSym(body.car, "=>")) {
      // (test => proc): arm value is (proc test) — proc's operand cone unioned
      // with the test cone (the test value flows into the arm).
      const procRest = body.cdr;
      const procNode =
        procRest instanceof APair ? classifyWith(procRest.car, c, subst) : ({ kind: "literal" } as LineageNode);
      arms.push(combine("=>", [procNode, testNode]));
    } else if (body instanceof APair) {
      arms.push(classifyBegin(body, c, subst));
    } else {
      arms.push(testNode); // `(test)` with no body returns the test value itself
    }
  }
  return { kind: "mux", op: "cond", selector: combine("cond", tests), arms };
}

/**
 * Let-family TRANSPARENT: body under subst name → classify(RHS). Sequential forms
 * thread left-to-right. Named let → `binder{cycles:true}` over RHSs+body (same
 * shape as `do`).
 */
function classifyLet(rest: unknown, c: Classifier, subst: Subst, sequential: boolean): LineageNode {
  if (!(rest instanceof APair)) return { kind: "literal" };

  // Named let: (let name (bindings) body…) — recursion ⇒ a cyclic binder (not
  // transparently inlineable, but a genuine loop shape, not opaque).
  if (rest.car instanceof ASymbol) {
    const afterName = rest.cdr;
    if (!(afterName instanceof APair)) return { kind: "literal" };
    const rhss = letBindingValues(afterName.car).map((v) => classifyWith(v, c, subst));
    const body = classifyBegin(afterName.cdr, c, subst);
    return { kind: "binder", op: "named-let", cycles: true, children: [...rhss, body].filter(isProvBearing) };
  }

  const bindings = rest.car;
  const body = rest.cdr;

  // Build the substitution: leaf-slot ← classify(RHS). `let` classifies every
  // RHS in the OUTER subst (parallel); `let*`/`letrec` extend as they go.
  const sequentialSubst = new Map(subst);
  const parallelOuterSubst = subst;
  let bindNode: unknown = bindings;
  while (bindNode instanceof APair) {
    const binding = bindNode.car;
    bindNode = bindNode.cdr;
    if (!(binding instanceof APair) || !(binding.car instanceof ASymbol)) continue;
    const name = opName(binding.car);
    const rhsExpr = binding.cdr instanceof APair ? binding.cdr.car : undefined;
    const rhsSubst = sequential ? sequentialSubst : parallelOuterSubst;
    const rhsNode = rhsExpr === undefined ? ({ kind: "literal" } as LineageNode) : classifyWith(rhsExpr, c, rhsSubst);
    sequentialSubst.set(name, rhsNode);
  }

  return classifyBegin(body, c, sequentialSubst);
}

function letBindingValues(bindings: unknown): unknown[] {
  const out: unknown[] = [];
  let n: unknown = bindings;
  while (n instanceof APair) {
    const b = n.car;
    if (b instanceof APair && b.cdr instanceof APair) out.push(b.cdr.car);
    n = n.cdr;
  }
  return out;
}

/**
 * `(do …)` → `binder{cycles:true}`: steps read prior iteration vars (back-edge).
 * Conservative barrier — classify every init/step/test/result/body, flat union.
 * deferred: per-iteration attribution / real backedge topology.
 *
 * Raw surface pairs only (not evaluator normalizeBindings) — bracket-clause
 * surface is unmodeled (same gap class as case/while/quasiquote).
 */
function classifyDo(rest: unknown, c: Classifier, subst: Subst): LineageNode {
  if (!(rest instanceof APair)) return { kind: "literal" };
  const children: LineageNode[] = [];

  let bindNode: unknown = rest.car;
  while (bindNode instanceof APair) {
    const binding = bindNode.car;
    bindNode = bindNode.cdr;
    if (!(binding instanceof APair)) continue;
    let exprNode: unknown = binding.cdr; // skip the var name itself
    while (exprNode instanceof APair) {
      children.push(classifyWith(exprNode.car, c, subst));
      exprNode = exprNode.cdr;
    }
  }

  // (test result…) body… — the test/result clause, then the per-iteration commands.
  const afterBindings = rest.cdr;
  if (afterBindings instanceof APair) {
    let clauseNode: unknown = afterBindings.car;
    while (clauseNode instanceof APair) {
      children.push(classifyWith(clauseNode.car, c, subst));
      clauseNode = clauseNode.cdr;
    }
    let bodyNode: unknown = afterBindings.cdr;
    while (bodyNode instanceof APair) {
      children.push(classifyWith(bodyNode.car, c, subst));
      bodyNode = bodyNode.cdr;
    }
  }

  return { kind: "binder", op: "do", cycles: true, children: children.filter(isProvBearing) };
}

/** `(begin e…)` — pass-through of the LAST expression (earlier values dropped). */
function classifyBegin(body: unknown, c: Classifier, subst: Subst): LineageNode {
  let last: unknown;
  let n: unknown = body;
  while (n instanceof APair) {
    last = n.car;
    n = n.cdr;
  }
  return last === undefined ? { kind: "literal" } : classifyWith(last, c, subst);
}

/** Runtime bindings: a slot/source name → the provenance ids it carries. */
export type Bindings = Record<string, readonly number[]>;

/**
 * One parameterized backward fold. Knobs:
 *   - `countOnly` — cardinality prunes length-preserving fan transform
 *   - `demand` — projection: only matching field; non-match is pruned sibling
 */
function walk(n: LineageNode, b: Bindings, out: Set<number>, opts: { countOnly?: boolean; demand?: PathStep }): void {
  switch (n.kind) {
    case "literal":
      return;
    case "leaf":
      (b[n.slot] ?? []).forEach((x) => out.add(x));
      return;
    case "source":
      (b[n.op] ?? []).forEach((x) => out.add(x));
      return;
    case "pipe":
    case "transparent":
      // transparent mints nothing — cone-identical to pipe.
      walk(n.child, b, out, opts);
      return;
    case "field":
      if (opts.demand) {
        // Match → full cone of child (demand satisfied). Miss → pruned sibling.
        if (sameStep(n.step, opts.demand)) walk(n.child, b, out, {});
        return;
      }
      // Cone: focused child only; key does not change the set walk.
      walk(n.child, b, out, opts);
      return;
    case "merge":
    case "opaque":
    case "sink":
    case "binder":
      // DEMAND BARRIERS — children walked with demand dropped, countOnly kept:
      //   merge: fan-in to a FRESH value; field cannot be attributed to one child
      //   opaque: no visible structure to justify narrowing
      //   sink/binder: same children-array shape; conservative barrier is sound
      //
      // TERMINATION for binder{cycles}: `cycles` is a semantic marker, not a tree
      // back-edge. classify builds only by finite downward recursion over a finite
      // AST — never expands call sites — so children stay acyclic. No visit-set
      // until real backedge topology exists (would guard a cycle this layer cannot produce).
      for (const ch of n.children) walk(ch, b, out, opts.demand ? { countOnly: opts.countOnly } : opts);
      return;
    case "mux":
      // selector ∪ every arm; field demand crosses into both arms (over-approx, not barrier).
      walk(n.selector, b, out, opts);
      n.arms.forEach((arm) => walk(arm, b, out, opts));
      return;
    case "fan":
      // Length-preserving map: count does not depend on per-element transform.
      walk(n.source, b, out, opts);
      if (opts.countOnly && n.lengthPreserving) return;
      if (n.introduces) (b[n.op] ?? []).forEach((x) => out.add(x));
      return;
    default:
      assertNever(n);
  }
}

export function fullCone(n: LineageNode, b: Bindings): number[] {
  const out = new Set<number>();
  walk(n, b, out, {});
  return [...out].toSorted((a, z) => a - z);
}

/** Minimal demand-cone for a cardinality observation (a count): prunes the
 *  length-preserving transforms a count cannot depend on. */
export function countCone(n: LineageNode, b: Bindings): number[] {
  const out = new Set<number>();
  walk(n, b, out, { countOnly: true });
  return [...out].toSorted((a, z) => a - z);
}

/** Sorted provenance ids on a value; `[]` for non-AValue. Eager-stamp reader for
 *  golden-prov / checkpoint / conservation laws. */
export function provOf(v: unknown): number[] {
  return v instanceof AValue ? [...v.provenance].toSorted((a, b) => a - b) : [];
}

export function sameStep(a: PathStep, z: PathStep): boolean {
  if ("field" in a) return "field" in z && a.field === z.field;
  if ("car" in a) return "car" in z;
  return "index" in z && a.index === z.index;
}

/**
 * Demand-as-projection: cone when only one field is observed. Matching field
 * followed; non-matching field is pruned sibling. Other nodes propagate demand
 * toward the producer. One walk parameter — no separate optic machinery.
 */
export function fieldCone(n: LineageNode, b: Bindings, step: PathStep): number[] {
  const out = new Set<number>();
  walk(n, b, out, { demand: step });
  return [...out].toSorted((a, z) => a - z);
}

/** Named location only: keyword field → bare name; positional car/index → null
 *  (forwards). Index stays on `.step` for fan axis; never a fields key. */
export function stepKey(step: PathStep): string | null {
  if ("field" in step) return step.field;
  return null;
}

/**
 * Field projection → join consumers:
 *   - `base` — producer points (`fullCone` of focused child; key discarded)
 *   - `key` — innermost projected step after absorption (no composed path)
 * Non-field: `key = null`, `base = fullCone(node)`.
 */
export interface FieldResolution {
  readonly base: number[];
  readonly key: string | null; // named field-name or forwarded; never a positional index
}

export function fieldResolve(n: LineageNode, b: Bindings): FieldResolution {
  if (n.kind === "field") {
    return { base: fullCone(n.child, b), key: stepKey(n.step) };
  }
  return { base: fullCone(n, b), key: null };
}

/**
 * Opaque quarantine counter — opaque is a citizen, not an error; corpus counts
 * are a shrink-only drift alarm. Population walk (visits fan templates and every
 * branch), not cone reachability. Baseline pinning is the caller's concern.
 */
export function countOpaqueNodes(n: LineageNode): number {
  switch (n.kind) {
    case "literal":
    case "leaf":
    case "source":
      return 0;
    case "pipe":
    case "transparent":
    case "field":
      return countOpaqueNodes(n.child);
    case "fan":
      return countOpaqueNodes(n.source) + (n.template ? countOpaqueNodes(n.template) : 0);
    case "mux":
      return countOpaqueNodes(n.selector) + n.arms.reduce((sum, arm) => sum + countOpaqueNodes(arm), 0);
    case "merge":
    case "sink":
    case "binder":
      return n.children.reduce((sum, ch) => sum + countOpaqueNodes(ch), 0);
    case "opaque":
      return 1 + n.children.reduce((sum, ch) => sum + countOpaqueNodes(ch), 0);
    default:
      // Same exhaustiveness contract as walk(): a new LineageNode kind without a
      // count arm fails to compile here rather than silently under-counting.
      assertNever(n);
  }
}
