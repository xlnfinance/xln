/**
 * MDL collapse optimizer — decides which AST-licensed boxes to fold in the
 * causal graph, by minimizing a Minimum-Description-Length cost. This is the
 * anti-spaghetti core of the causal-graph view.
 *
 * ── Formally-correct grammar (SLP) cost ──────────────────────────────────────
 * The description is a straight-line grammar over the provenance trace. A
 * collapsed box is a NONTERMINAL: its body (definition) is written ONCE, and
 * every occurrence pays only a REFERENCE (a symbol id + the ×n count + its port
 * bindings). An expanded box is inlined: its body is written at every
 * occurrence. This def/ref split is load-bearing: a single per-node cost
 * (`n × bodyBits`) re-charges a shared child's whole body inside every inlined
 * parent copy, producing answers up to 3.5× over optimal whenever a collapsed box
 * nests under an expanded one (the exact binding-residual regime the design leans
 * on) — the def/ref split is what avoids that double-count.
 *
 * ── Why it's optimal AND a cheap two-pass DP ─────────────────────────────────
 * Candidates are GIVEN by the AST (every map/reduce=unfold/fold, cond/case=dnf,
 * named-let=loop) and NEST → a laminar family = containment forest. The number
 * of trace-slots a scope occupies, `ancestorMult(s)` = ∏ strict-ancestor
 * multiplicities, is a pure structural product, independent of any
 * collapse/expand decision. Precompute it top-down; then each scope's decision
 * (compare its COLLAPSED vs EXPANDED total contribution, given `ancestorMult`
 * and its children's already-resolved placements) is INDEPENDENT of every other
 * scope's decision — so greedy bottom-up local minimization is globally
 * optimal. No search, no global budget, polynomial. (Refs: VoG additive
 * L(M)+L(E) — Koutra et al., https://arxiv.org/abs/1406.3411 — NOT SUBDUE's
 * ratio, which doesn't decompose over the DP; SLP/grammar compression — Lohrey.)
 *
 * ── Stability (grouping is run-invariant up to topology) ─────────────────────
 * Every quantity in the objective is STRUCTURAL: `localBits` (a scope's own
 * sub-DAG size), `boundaryPorts` (its external bindings), `distinctShapes` (how
 * many distinct sub-DAG SHAPES its instances take — topology, NOT values), and
 * `n` (trace multiplicity). No per-instance VALUE enters the decision, so value
 * noise never jitters the layout — a per-instance residual term is excluded for
 * exactly that reason. Box existence is invariant across all runs; only ×n labels
 * and which boxes are collapsed at a given zoom vary with trace topology —
 * which is correct (a loop that ran once should not read as a stack).
 *
 * Scope: this is the decision engine. `localBits`/`boundaryPorts` are abstract
 * structural bit-counts; the bit-exact prefix-coded adjacency accounting (E⁺/E⁻
 * matrices) and the AST→candidate-forest extraction are the productionization
 * steps. The cost ALGEBRA here is the formally-correct one.
 */

import type { CandidateBox, Decision } from "./trace-to-forest.js";

export interface CollapseParams {
  /** λ — zoom knob, scales the per-occurrence reference overhead. LOW λ ⇒ cheap
   *  references ⇒ MORE collapse ⇒ fewer visible nodes (zoomed OUT); HIGH λ ⇒
   *  expensive references ⇒ instances inlined (zoomed IN). #collapsed is monotone
   *  non-increasing in λ. Lagrangian dual of a hard box-limit K. Default 1. */
  lambda?: number;
}

export interface CollapseResult {
  decisions: Map<string, Decision>;
  /** Total description length (bits) of the optimal grouping. */
  totalBits: number;
  /** Fully-expanded (raw) description length — the admissibility anchor: a
   *  grouping is only admitted if it beats this. `totalBits <= rawBits` always. */
  rawBits: number;
}

const log2 = (k: number): number => (k <= 1 ? 0 : Math.log2(k));
/** Rissanen universal integer code length (bits). Exact constant log2(2.865). */
const universalIntBits = (n: number): number => log2(n) + Math.log2(2.865);

/** Count scopes in the forest → the grammar alphabet size; a reference names one
 *  symbol, so refBits = log2(alphabet). */
function countScopes(forest: CandidateBox[]): number {
  let c = 0;
  const walk = (b: CandidateBox): void => {
    c++;
    for (const ch of b.children) walk(ch);
  };
  for (const b of forest) walk(b);
  return c;
}

interface Ctx {
  lambda: number;
  refBits: number;
  out: Map<string, Decision>;
}

/** Per-occurrence reference cost: name the nonterminal + its ×n count + bind its
 *  ports. Scaled by λ (the zoom knob). */
function refCost(box: CandidateBox, ctx: Ctx): number {
  const ports = box.boundaryPorts ?? 0;
  return ctx.lambda * (ctx.refBits + universalIntBits(box.n) + ports * ctx.refBits);
}

/**
 * Post-order DP. `ancestorMult` = ∏ strict-ancestor multiplicities = the number
 * of trace-slots this scope occupies (precomputed structurally — independent of
 * decisions). Returns `{ defBits, placeBits }`:
 *   - defBits  = total one-time definition bits in this subtree (collapsed
 *     nonterminals' bodies, each counted once).
 *   - placeBits = cost to place ONE occurrence of this scope in its parent's
 *     body: a reference if collapsed, else n inlined body copies.
 * Decision per scope: COLLAPSED iff its total contribution is cheaper.
 *   COLLAPSED total = defBody(once) + ancestorMult·refCost + shape-selector
 *   EXPANDED total  = ancestorMult · n · defBody
 * (defBody = localBits + Σ children placeBits; a collapsed child contributes a
 * cheap reference here, NOT its whole body — this is the fix to the double-count.)
 */
function solve(box: CandidateBox, ancestorMult: number, ctx: Ctx): { defBits: number; placeBits: number } {
  let childDefBits = 0;
  let childPlaceBits = 0;
  const childMult = ancestorMult * box.n; // each child occupies this many slots
  for (const child of box.children) {
    const r = solve(child, childMult, ctx);
    childDefBits += r.defBits;
    childPlaceBits += r.placeBits;
  }

  const defBody = box.localBits + childPlaceBits; // one instance of this box's body
  const shapeSelector = ancestorMult * box.n * log2(box.distinctShapes ?? 1);

  const collapsedTotal = defBody + ancestorMult * refCost(box, ctx) + shapeSelector;
  const expandedTotal = ancestorMult * box.n * defBody;

  // `force` overrides the MDL decision (a "forced" promoted define, or a human
  // force-expand). Otherwise COLLAPSED wins ties (bias to the compressed view).
  const collapse = box.force ? box.force === "collapsed" : collapsedTotal <= expandedTotal;

  if (collapse) {
    ctx.out.set(box.id, "collapsed");
    // Definition paid once here; parent pays only a reference per slot.
    return { defBits: childDefBits + defBody, placeBits: refCost(box, ctx) };
  }
  ctx.out.set(box.id, "expanded");
  // No nonterminal; parent inlines n copies of the body (children defs still
  // counted once via childDefBits — that's the double-count fix).
  return { defBits: childDefBits, placeBits: box.n * defBody };
}

/** Fully-expanded (raw) description length: every instance's local structure
 *  written out, no references/ports. Σ over scopes of ancestorMult·n·localBits. */
function rawCost(forest: CandidateBox[]): number {
  let total = 0;
  const walk = (b: CandidateBox, ancestorMult: number): void => {
    total += ancestorMult * b.n * b.localBits;
    for (const ch of b.children) walk(ch, ancestorMult * b.n);
  };
  for (const b of forest) walk(b, 1);
  return total;
}

/**
 * Run the optimizer. Children/forest are processed in id-sorted order so the
 * decision map is deterministic regardless of input array order.
 */
export function collapseMDL(forest: CandidateBox[], params: CollapseParams = {}): CollapseResult {
  const sortById = (boxes: CandidateBox[]): CandidateBox[] =>
    [...boxes]
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .map((b) => ({ ...b, children: sortById(b.children) }));
  const sorted = sortById(forest);

  const ctx: Ctx = { lambda: params.lambda ?? 1, refBits: log2(countScopes(sorted)) || 1, out: new Map() };

  let totalBits = 0;
  for (const root of sorted) {
    const r = solve(root, 1, ctx);
    totalBits += r.defBits + r.placeBits; // start symbol places each root once
  }
  return { decisions: ctx.out, totalBits, rawBits: rawCost(sorted) };
}
