/**
 * The interactive-run NAV MODEL — the semantic handle the render sits on, built BEFORE
 * any tint, so the projection is honest by construction.
 *
 * The load-bearing fact, confirmed by real traces (docs/interactive-run-design.md's
 * probe): one source form (a parser Pair = a TEMPLATE, keyed by `scopeId`) maps to N
 * dynamic invocations — `(fib 10)`'s `if` runs 177 times, `(* n n)` runs once per list
 * element. "Tint the source form" therefore CANNOT be a pure recolor of one glyph: a form
 * has a *set* of invocation states, and its displayed state is an AGGREGATE over that set.
 * This module computes that aggregate + the multiplicity (the `×N` count that is the
 * "there is a dynamic tree behind me" affordance), leaving rendering to the painter.
 *
 * Pure and headless: `runView(trace)` reads a settled (or in-flight) `EvalTrace` and
 * returns source-ordered `TemplateNode`s. No TTY, no ANSI — a test feeds a real trace and
 * asserts the nodes.
 */
import { headOf, scopeId, type EvalTrace, type InvocationState } from "@inhuman.tools/arrival/provenance";

/** A source form's aggregated execution state. `unreached` = dim (no invocation yet);
 *  `running` = the one live glyph; `error` = at least one invocation rejected. */
export type TemplateState = "unreached" | "running" | "done" | "error";

export interface TemplateNode {
  /** Stable structural id `head@[source:]line:col` — the drill-down key. */
  readonly scope: string;
  /** Head symbol (`map`, `fib`, `*`, `if`) — what the eye reads. */
  readonly head: string;
  readonly line: number;
  readonly col: number;
  /** Invocation multiplicity. `>1` earns the `×N` badge (auto-promote to "poke me"). */
  readonly count: number;
  readonly state: TemplateState;
}

/**
 * THE aggregation rule (named, so it can't drift): a template's state folds its
 * invocations' states. Precedence error > running > done, and empty is `unreached`.
 * `error` wins outright — a rejected invocation is the thing you most need to see — so
 * the scan returns it eagerly; `running` only concludes once no rejection is present.
 */
export function aggregateState(states: Iterable<InvocationState>): TemplateState {
  let seen = false;
  let running = false;
  for (const s of states) {
    seen = true;
    if (s === "rejected") return "error";
    if (s === "running") running = true;
  }
  if (!seen) return "unreached";
  return running ? "running" : "done";
}

const LOCATION = Symbol.for("__location__");

/** Line/col off a located Pair's `__location__` symbol (the reader stamps it; only
 *  located Pairs enter the trace, so this is present in practice — `null` guards the
 *  macro-expanded/synthetic case rather than widening the node type). */
function locationOf(node: unknown): { line: number; col: number } | null {
  if (node !== null && typeof node === "object") {
    const loc = (node as Record<symbol, unknown>)[LOCATION] as { line?: number; col?: number } | undefined;
    if (loc !== undefined && typeof loc.line === "number") return { line: loc.line, col: loc.col ?? 0 };
  }
  return null;
}

/**
 * Project a trace into source-ordered template nodes. One node per distinct source form
 * that the run touched (`trace.records` is keyed by template Pair); its `count` is how
 * many times it ran, its `state` the aggregate. Sorted by source position so the outline
 * reads top-to-bottom like the program. Unlocated records (no `__location__`) are dropped
 * — they have no place in a source view.
 */
export function runView(trace: EvalTrace): TemplateNode[] {
  const nodes: TemplateNode[] = [];
  for (const [pair, rec] of trace.records) {
    const loc = locationOf(pair);
    if (loc === null) continue;
    const states: InvocationState[] = [];
    for (const inv of rec.bindings) states.push(inv.state);
    nodes.push({
      scope: scopeId(pair),
      head: headOf(pair),
      line: loc.line,
      col: loc.col,
      count: rec.bindings.size,
      state: aggregateState(states),
    });
  }
  nodes.sort((a, b) => a.line - b.line || a.col - b.col);
  return nodes;
}
