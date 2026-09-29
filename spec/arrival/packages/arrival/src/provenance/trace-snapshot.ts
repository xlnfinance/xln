/**
 * Plain (non-observable) mirror of an EvalTrace, for the flow-graph build.
 *
 * `snapshotTrace` is the boundary between the live, still-mutating trace and the
 * graph build (`traceToStatechart` / `traceToForest`): one linear pass copies the
 * fields the build needs into plain objects/Sets so the expensive build reads only
 * immutable-for-its-lifetime structures.
 *
 * ── structured-clone contract (the worker boundary) ─────────────────────────
 * `PlainInv.node` is not structured-clone-safe: a clone strips symbol-keyed
 * `__location__`, so `scopeId` degrades from `head@line:col` to bare `head`.
 * Pre-derive `scope` (`scopeId(node)`) while the live Pair is in hand.
 */
import { toJS } from "../membrane/rosetta.js";
import type { APair } from "../values/primitives/APair.js";
import type { SchemeValue } from "../values/types.js";

import { scopeId } from "./scope-id.js";
import type { EvalTrace, InvocationState } from "./trace.js";

/** Exactly the Invocation fields the flow-graph build reads. The AST `node` is a
 *  plain Pair, shared by reference — its identity is load-bearing (cells and
 *  forest boxes group by Pair identity). */
export interface PlainInv {
  id: number;
  /** Live arrival-scheme `Pair`, shared by reference — its identity is load-bearing
   *  (consumers group by Pair identity and read `__location__` via `scopeId`). This
   *  is the ONE field that is NOT structured-clone-safe: a clone loses the prototype,
   *  cross-snapshot identity, and the symbol-keyed `__location__`. A2 must project it
   *  to a plain shape before `postMessage`. See the structured-clone contract in this
   *  file's header and `arrival-chain`'s `src/__tests__/trace-snapshot-clone.test.ts`. */
  node: APair<SchemeValue, SchemeValue>;
  /** Pre-derived `scopeId(node)` (`head@line:col`) — the clone-safe twin of `node`.
   *  `scopeId` reads the symbol-keyed `__location__` off the live Pair, which
   *  `structuredClone` strips; deriving it here (while the live Pair is in hand)
   *  is what lets the off-thread region build key by scope without the Pair. The
   *  worker-side `traceToRegions` rewrite (A2) reads THIS instead of `scopeId(node)`,
   *  and `a.node === b.node` identity checks become `a.scope === b.scope` (scopeId
   *  already collapses by Pair identity, so equal nodes yield equal strings). */
  scope: string;
  parent: PlainInv | null;
  children: PlainInv[];
  /** Upstream producer ids — materialized ONLY for direct children of provenance
   *  points, the sole place the build reads provenance (statechart step 2). Empty
   *  elsewhere: loop/plumbing invocations accumulate O(n) provenance up the
   *  recursion, so copying all of it made the snapshot O(n²); copying only the
   *  consumed sets keeps it O(n). If a consumer ever needs provenance off a
   *  non-point-child, widen this predicate. */
  provenance: ReadonlySet<number>;
  isProvenancePoint: boolean;
  /** Resolved value — copied for provenance points only (the render reads it for a
   *  node's result). `undefined` while running and for non-points. */
  value: unknown;
  /** Node metadata, bound by the rosetta fn at call time — points only (`undefined`
   *  otherwise). e.g. a `.prompt` node's `{ kind, path, model, inputs }`. */
  metadata: unknown;
  state: InvocationState;
  /** Rejection detail — `Invocation.error` stringified at snapshot time (clone-safe).
   *  Points only, `rejected` only; `undefined` otherwise. The render labels the failed
   *  card with it instead of a bare `⚠ failed`. */
  error?: string;
  /** infer cache HIT (replayed free) vs fresh (paid) call. Points only; `undefined` for
   *  non-infer. The free-vs-paid cost signal — "nothing costs anything until ▶, and a
   *  pre-cached trace replays for free". */
  cached?: boolean;
}

export interface PlainTrace {
  invocations: PlainInv[];
}

/** The branch heads whose children carry decision-relevant values. A child of one
 *  of these is a branch TEST or chosen-ARM evaluation; we materialize its `value`
 *  so the region build can substitute the runtime outcome into a readable decision
 *  pill (`fails is empty → yes`). Bounded — a branch has a few children, not O(n). */
const BRANCH_HEADS: ReadonlySet<string> = new Set(["if", "cond", "case", "when", "unless"]);
const headName = (node: APair<SchemeValue, SchemeValue> | undefined): string | undefined => {
  const car = (node as { car?: unknown } | undefined)?.car;
  const n = (car as { __name__?: unknown } | undefined)?.__name__;
  return typeof n === "string" ? n : undefined;
};

/** Stringify a rejection for the snapshot. An `Error` is its message; anything else its
 *  `String(…)`; nullish → undefined. A string is structured-clone-safe (the live `error:
 *  unknown` / `Error` would lose its prototype across `postMessage`). */
const errText = (e: unknown): string | undefined =>
  e instanceof Error ? e.message : e == null ? undefined : String(e);

/** Shared empty set for invocations whose provenance the build never reads. */
const NO_PROVENANCE: ReadonlySet<number> = new Set();

export function snapshotTrace(trace: EvalTrace): PlainTrace {
  const byId = new Map<number, PlainInv>();
  const invocations: PlainInv[] = [];
  for (const rec of trace.records.values()) {
    for (const inv of rec.bindings) {
      const isPoint = inv.isProvenancePoint;
      // A parentless invocation is a top-level form; the LAST one is the program's
      // STATEMENT OUTPUT. We materialize its value + provenance too (a handful of
      // roots, so still O(n)) so the region build can render the program's returned
      // value as a terminal node wired from its producers.
      const isRoot = !inv.parent;
      // A child of a branch form is a test/arm evaluation — materialize its value so
      // the readable decision pill can show the runtime outcome (`→ yes` / `→ no`).
      const isBranchChild = BRANCH_HEADS.has(headName(inv.parent?.node) ?? "");
      const plain: PlainInv = {
        id: inv.id,
        node: inv.node,
        // Pre-derive scope NOW, while `inv.node` is the live Pair (its symbol-keyed
        // `__location__` is gone after a structuredClone). This is the one piece of
        // node's identity the build needs that does not survive the worker boundary.
        scope: scopeId(inv.node),
        parent: null,
        children: [],
        // Only children of provenance points — plus the top-level roots — have their
        // provenance read downstream; everything else accumulates O(n) provenance we'd
        // never look at.
        provenance: inv.parent?.isProvenancePoint || isRoot ? new Set(inv.provenance) : NO_PROVENANCE,
        isProvenancePoint: isPoint,
        // value + metadata are read by the render only for the leaves it draws
        // (provenance points) and the program-output root; copying them for every
        // invocation would make the snapshot track every intermediate value's
        // resolution.
        //
        // `inv.value` is the rosetta result AS SCHEME SEES IT — a provenance-stamped
        // AValue (the wrapper `jsToScheme`'d it on the way back). `toJS` peels that
        // envelope to plain JS so the render shows the string, not
        // `{ provenance, kind, __string__ }`.
        value:
          isPoint || isRoot || isBranchChild
            ? inv.value === undefined
              ? undefined
              : toJS(inv.value as SchemeValue)
            : undefined,
        metadata: isPoint ? inv.metadata : undefined,
        state: inv.state,
        // Rejection detail + cache flag — points only (the leaves the render draws), gated
        // exactly like `value`/`metadata`. Both are clone-safe primitives (string/boolean).
        error: isPoint && inv.state === "rejected" ? errText(inv.error) : undefined,
        cached: isPoint ? inv.cached : undefined,
      };
      byId.set(inv.id, plain);
      invocations.push(plain);
    }
  }
  // Pass 2: wire parent/children by id (both endpoints now exist as plain nodes).
  for (const rec of trace.records.values()) {
    for (const inv of rec.bindings) {
      const plain = byId.get(inv.id)!;
      if (inv.parent) plain.parent = byId.get(inv.parent.id) ?? null;
      for (const child of inv.children) {
        const childPlain = byId.get(child.id);
        if (childPlain) plain.children.push(childPlain);
      }
    }
  }
  return { invocations };
}
