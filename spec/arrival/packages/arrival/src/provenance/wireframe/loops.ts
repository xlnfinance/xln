/**
 * LOOP WIREFRAMING. Two independent halves live here:
 *
 *  1. Pure, GraphBuilder-free PARSING of `do`'s surface shape — `(do ((var init
 *     step?)…) (test result…) body…)`. Mirrors `../lineage.js`'s `classifyDo`
 *     (same raw-Pair walk, same R7RS default-step rule) rather than the evaluator's
 *     `normalizeBindings`/`normalizeClause` — this is a STATIC pre-execution read,
 *     same category as that file's own header note ("a bracket-clause surface is a
 *     known gap, untested by any corpus today"). `builder.ts`'s `GraphBuilder`
 *     consumes these to build a `do` binder's interior (deep private-state access
 *     — `addNode`/`emitWire`/`walkDropped`/`emitEgress` — keeps that construction a
 *     `GraphBuilder` method; this file supplies only the shape).
 *
 *     Named-let needs no equivalent extractor: its shape is the ordinary `let`
 *     binding-list `letEntries` (builder.ts) already parses, plus the loop name —
 *     `buildNamedLetBinder` reads both directly.
 *
 *  2. `reachableNodes` — a backward reachability walk over ONE `WireframeGraph`,
 *     carrying an explicit visited-set. `../lineage.js`'s `walk()` earns
 *     termination FOR FREE from classify()'s finite downward structural recursion
 *     (its own header: "no `LineageNode` object can reach itself through
 *     `.children`/`.child`" — an object-identity argument). A `WireframeGraph`
 *     node is addressed by ARRAY INDEX, not by the object-identity tree classify()
 *     builds, and a `binder.interior` graph contains a genuine BACKEDGE (`recur`)
 *     alongside the very designated nodes its ingress wires reference — so a
 *     traversal over this shape does not inherit classify()'s free acyclicity
 *     proof and must earn termination directly. The wireframe-builder law rows
 *     (`__tests__/wireframe-builder.test.ts`) exercise this both over a REAL loop
 *     interior (a DAG today — terminates trivially) and over a SYNTHETIC
 *     index-level cycle (the honest proof the guard is load-bearing, not
 *     decorative).
 *
 *  3. `reachableNodesForDemand` — the SAME backward walk, GRADED by demand:
 *     `"value"` reproduces `reachableNodes` exactly (every ingress wire is followed,
 *     tagged or not); `"count"` follows a wire only if it carries `builder.ts`'s
 *     `factTagOf` TAG **or** is a `fan` node's own container-source wire (the
 *     STRUCTURAL PRODUCER — the PROXIED/PROVENANCED container-fact discipline says
 *     a fan's container ALWAYS contributes to its result's length fact, so this wire
 *     is never "element" even though it carries no fact tag itself: its consumer is
 *     the fan, not a length-verb). Every OTHER untagged wire is pruned WHOLESALE the
 *     instant it would be expanded, never contributing a node to the returned set —
 *     a count-demand cone traverses fact wires ONLY, touching ZERO element wires,
 *     made structural: mirrors `../lineage.js`'s retrospective
 *     `countCone`/`walk`'s `countOnly` knob, whose fan arm calls `walk(n.source, …)`
 *     UNCONDITIONALLY and only prunes the per-element TRANSFORM when
 *     `countOnly && lengthPreserving`. The prospective graph never had a wire for
 *     that transform to begin with (I5: a fan's callback body is a PRIVATE
 *     interior, never spliced into the enclosing graph) — so the fan-source carve-
 *     out above is this walk's one needed departure from "tag-only," and it is the
 *     WHOLE departure. `reachableNodes` is kept as the un-graded call (every
 *     existing caller) for `"value"` demand, byte-stable.
 */
import { APair } from "../../values/primitives/APair.js";
import { ASymbol } from "../../values/primitives/ASymbol.js";
import type { WireframeGraph } from "./types.js";

function opName(x: unknown): string {
  const v = (x as { valueOf?: () => unknown })?.valueOf?.();
  return typeof v === "string" || typeof v === "symbol" ? String(v) : String(x);
}

/** Elements of a proper pair chain (mirrors builder.ts's own private copy — the
 *  established per-file convention, see e.g. `wireframe/free-vars.ts`'s header). */
function chainOf(n: unknown): unknown[] {
  const out: unknown[] = [];
  let cur: unknown = n;
  while (cur instanceof APair) {
    out.push(cur.car);
    cur = cur.cdr;
  }
  return out;
}

/** One `do` binding: `(var init step?)`. `step` is NEVER absent in the returned
 *  shape — R7RS: an omitted step has "the same effect as if `(<variable> <init>
 *  <variable>)` had been written," i.e. the var carries its OWN current binding
 *  forward unchanged; that default is expressed here as `binding.car` ITSELF (the
 *  same `ASymbol` the var name came from), so a caller wiring `step` through the
 *  interior's ordinary `emitWire` resolves it exactly like any other variable read
 *  — no synthetic node, no special case. */
export interface DoBinding {
  readonly name: string;
  readonly init: unknown;
  readonly step: unknown;
}

/** Parse `do`'s binding-list datum `((var init step?)…)` into `DoBinding[]`. A
 *  malformed entry (not `(sym …)`) is skipped — mirrors `classifyDo`'s own
 *  tolerance (walks whatever bindings ARE well-formed; a caller building a graph
 *  from a malformed program has bigger problems than this parser catching it). */
export function parseDoBindings(bindingList: unknown): DoBinding[] {
  const out: DoBinding[] = [];
  let n: unknown = bindingList;
  while (n instanceof APair) {
    const b = n.car;
    n = n.cdr;
    if (!(b instanceof APair) || !(b.car instanceof ASymbol)) continue;
    const afterName = b.cdr;
    const init = afterName instanceof APair ? afterName.car : undefined;
    const stepRest = afterName instanceof APair ? afterName.cdr : undefined;
    const step = stepRest instanceof APair ? stepRest.car : b.car; // R7RS default: carry the var itself
    out.push({ name: opName(b.car), init, step });
  }
  return out;
}

export interface DoClause {
  readonly test: unknown;
  readonly resultForms: readonly unknown[];
}

/** The empty clause (a malformed/absent `do` clause) — no test, no result forms;
 *  `buildDoBinder` treats this as "the loop never wireframes a terminal egress." */
export const EMPTY_DO_CLAUSE: DoClause = { test: undefined, resultForms: [] };

export function parseDoClause(clause: unknown): DoClause {
  if (!(clause instanceof APair)) return EMPTY_DO_CLAUSE;
  return { test: clause.car, resultForms: chainOf(clause.cdr) };
}

/** Every node index reachable backward from `from` within one `WireframeGraph`.
 *  Follows ingress wires (`consumer.node` → `paramRefs` of kind `"node"`).
 *  Carries its own visited-set: the graph is index-addressed and may cycle. */
export function reachableNodes(graph: WireframeGraph, from: number): ReadonlySet<number> {
  return reachableNodesForDemand(graph, from, "value");
}

/** The demand grade: `"value"` follows every ingress wire; `"count"` follows only a
 *  wire the builder tagged `fact` PLUS a fan's own container-source wire (see this
 *  file's header, item 3, and `builder.ts`'s `factTagOf`). */
export type DemandGrade = "value" | "count";

/** `reachableNodes`, graded by demand. Same visited-set discipline as the ungraded walk.
 *  `"count"` follows `fact` tags plus a fan's `source*` wire; other untagged wires prune wholesale. */
export function reachableNodesForDemand(graph: WireframeGraph, from: number, demand: DemandGrade): ReadonlySet<number> {
  const visited = new Set<number>();
  const stack: number[] = [from];
  while (stack.length > 0) {
    const idx = stack.pop() as number;
    if (visited.has(idx)) continue; // the termination guard — without it, a cyclic
    visited.add(idx); // index topology sends this loop into unbounded iteration.
    const expanding = graph.nodes[idx];
    const isFanNode = expanding !== undefined && expanding.kind === "fan";
    for (const w of graph.wires) {
      if (w.consumer.node !== idx) continue;
      const isStructuralProducer = isFanNode && w.consumer.slot.startsWith("source");
      if (demand === "count" && w.fact === undefined && !isStructuralProducer) continue;
      for (const ref of w.paramRefs) {
        if (ref.kind === "node" && !visited.has(ref.node)) stack.push(ref.node);
      }
    }
  }
  return visited;
}
