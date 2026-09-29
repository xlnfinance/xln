/**
 * INCREMENTAL region fold — streaming twin of `traceToRegions` for APPEND-ONLY traces.
 * Rebuilds the same `RegionGraph` without re-walking the whole trace per frame.
 *
 *   - `applyDelta()` walks only NEW invocations (id ≥ cursor), O(Δ) not O(N).
 *   - `current()` reuses the EXACT `trace-to-regions.ts` helpers and freezes completed
 *     iterations (a loop iteration whose successor exists, or a resolved map app,
 *     reuses its already-built `Region[]`). Only the growth frontier recomputes.
 *
 * PARITY contract: `current()` deep-equals `traceToRegions` on every trace state.
 * Enforced by `src/__tests__/trace-region-fold.test.ts`. Achieved by reusing
 * `regionsAt` / `leafFor` / `attributeFieldEdges` / `derivePorts` / `addPointToHasse`
 * verbatim through the `RegionWalkCtx` seam — the two paths cannot drift.
 *
 * PHASE 1 main-thread: holds the live `EvalTrace`, reads decision-operand
 * value/provenance via `valueById` / `liveValueById`. Live reads into the snapshot
 * mirror deferred to Phase-2 (worker boundary); see `trace-snapshot.ts`.
 */
import type { APair } from "@inhuman.tools/arrival/reflect-internals";
import { toJS, type SchemeValue } from "@inhuman.tools/arrival";

import { carrierFieldEdges, scopedBindings, subtreeIds } from "./carrier-fields.js";
import { scopeId, type PlainInv, type EvalTrace, type Invocation } from "@inhuman.tools/arrival/provenance";
import { staticLoopBodyScopes, staticRecursiveHeads, STRUCTURAL_FORMS } from "./trace-to-forest.js";
import {
  addPointToHasse,
  appendDecisionEdges,
  appendOutput,
  attributeFieldEdges,
  attributeFromFields,
  decisionInputProducers,
  derivePorts,
  regionsAt,
  resolveOriginVia,
  routeOf,
  upstreamOfPoint,
  valueProvenance,
  walkSpine,
  type FinalizeCtx,
  type Region,
  type RegionEdge,
  type RegionGraph,
  type RegionWalkCtx,
} from "./trace-to-regions.js";

// Reuses the from-scratch SHAPE helpers by EXTENDING sets incrementally: `staticLoopBodyScopes`
// / `staticRecursiveHeads` (define-only) re-run lazily on a new define; `STRUCTURAL_FORMS`
// gates the dynamic recursive-head scan.

const EMPTY_NUM: ReadonlySet<number> = new Set();

const headOf = (inv: PlainInv): string => scopeId(inv.node).split("@")[0] ?? "?";
/** Snapshot's `errText`, inlined — kept identical so the fold's mirror deep-equals a fresh `snapshotTrace`. */
const errText = (e: unknown): string | undefined =>
  e instanceof Error ? e.message : e == null ? undefined : String(e);
const hasSelfAncestor = (inv: PlainInv): boolean => {
  for (let p = inv.parent; p; p = p.parent) if (p.node === inv.node) return true;
  return false;
};

const BRANCH_FORMS: ReadonlySet<string> = new Set(["if", "cond", "case", "when", "unless"]);

/** Set equality over strings (for live-branch membership change detection). */
function sameStringSet(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false;
  for (const x of a) if (!b.has(x)) return false;
  return true;
}

/** Deep-clone a built `Region[]`: cached template stays pristine while the returned graph
 *  (`derivePorts` mutates in place) is independent. Ports reset to `[]` (template captured
 *  pre-`derivePorts`). Structural copy, not `structuredClone`. */
function cloneRegions(regions: Region[]): Region[] {
  return regions.map(cloneRegion);
}
function cloneRegion(r: Region): Region {
  switch (r.kind) {
    case "leaf":
      return { ...r };
    case "decision":
      // verdicts is nested — copy it so the pristine template can't alias a mutated graph.
      return { ...r, ...(r.verdicts ? { verdicts: r.verdicts.map((v) => ({ ...v, origins: [...v.origins] })) } : {}) };
    case "output":
      return { ...r };
    case "fanout":
      return {
        kind: "fanout",
        id: r.id,
        scope: r.scope,
        stages: r.stages.map((s) => ({ ...s })),
        iterations: r.iterations.map(cloneRegions),
        incoming: r.incoming,
        ...(r.loop === undefined ? {} : { loop: r.loop }),
        inputs: [],
        outputs: [],
      };
  }
}

/** Cached iteration: pristine template + the decision wires from its first walk. Reuse
 *  clones the template AND replays the knot entries into the live walk collectors — a
 *  reused iteration is not re-walked, so its `<>` knot→arm / operand→knot edges must be
 *  replayed or lost. */
interface CachedIteration {
  template: Region[];
  knotArm: { knot: number; arm: number }[];
  knotInputs: { knot: number; from: number }[];
  /** Signal generation the template was built under (see `#shapeGen`). Stale when the
   *  generation advanced (branch flipped live, new loop body / recursive head) — changes
   *  region SHAPE. */
  gen: number;
}

export class TraceRegionFold {
  readonly #trace: EvalTrace;

  // ── cursor ──────────────────────────────────────────────────────────────────
  /** Index into append-ordered `invocationLog`. `invocationLog.slice(#logCursor)` = the
   *  delta, already in ascending-id (fold) order — O(Δ), no re-scan/sort. */
  #logCursor = 0;

  // ── snapshot mirror (the growing de-MobX'd PlainInv graph) ────────────────────
  readonly #invById = new Map<number, PlainInv>();
  /** Live invocation refs, for decision-operand value + provenance (KEEP live-read —
   *  snapshot drops plumbing values; absorption is Phase-2). */
  readonly #liveById = new Map<number, Invocation>();
  /** Mirrors captured while the live invocation was still `running` — lifecycle fields
   *  mutate on resolve. `traceToRegions` snapshots fresh each call, so the fold REFRESHES
   *  these to stay equal mid-flight. Bounded by running frontier; id drops out on settle. */
  readonly #runningIds = new Set<number>();

  // ── top-level (parentless) forms, in ascending id (= source order) ────────────
  // Incremental so `current()` need not re-filter all mirrors (O(N)). Ascending id =
  // source order; LAST = statement-output form (matches `snap.invocations` order).
  readonly #rootIds: number[] = [];

  // ── points + Hasse edges (incremental transitive reduction) ───────────────────
  readonly #points: PlainInv[] = [];
  readonly #pointIds = new Set<number>();
  readonly #reach = new Map<number, Set<number>>();
  readonly #baseEdges: RegionEdge[] = [];

  // ── recursion + branch-liveness signals (monotonic) ───────────────────────────
  readonly #recursiveHeads = new Set<string>();
  readonly #loopBodies = new Set<object>();
  /** Cached loop spines: ENTRY id → ordered body-entry ids (`nextSameBody` chain).
   *  Built O(Δ) so `current()` need not re-DFS recursion (spine walk otherwise O(N) per
   *  build). `#bodyEntryOf`: body-entry id → its loop's entry id. */
  readonly #loopSpines = new Map<number, number[]>();
  readonly #bodyEntryOf = new Map<number, number>();
  /** Per-scope branch-invocation ids + per-invocation CURRENT route (last evaluated
   *  child's node). Stored per-invocation (not accumulating) so a route SHIFTING as an
   *  arm fills replaces the old — matching a fresh `routeOf`; otherwise a streaming branch
   *  records stale intermediate routes and spuriously goes live. */
  readonly #branchInvsByScope = new Map<string, Set<number>>();
  readonly #branchRouteByInv = new Map<number, object>();
  /** Live-branch scope set, recomputed per `applyDelta` (branches sparse), reused by `current()`. */
  #liveBranchScopes = new Set<string>();
  /** DYNAMIC-CAPABLE scopes: ≥1 branch's tested operand traces (via `decisionInputProducers`
   *  + provenance) to an infer point — EXACTLY `regionsAt`'s `wired.size > 0` (parity).
   *  Monotonic. Why it matters: a non-dynamic branch DISSOLVES identically live-or-not, so
   *  only a scope that is BOTH live AND dynamic-capable renders a `<>`. The iteration cache
   *  invalidates only when live∩dynamic changes, NOT on every liveBranchScopes change — else
   *  the GEPA loop's static tail-`if` going live at the FINAL iteration clears the whole cache
   *  and forces a full O(N) re-walk (a ~1.4s hitch at 500k) for a change altering no region. */
  readonly #dynamicCapableScopes = new Set<string>();
  /** Scopes whose dynamic-capability was checked (wiredness is a source-structure property,
   *  identical per scope, so the O(depth) `#isWired` walk runs once per scope). */
  readonly #wiredChecked = new Set<string>();
  /** `(define …)` seen since static loop/recursion scan last ran? Static readers depend
   *  only on defines, so re-run lazily on define. */
  #pendingDefine = false;

  // ── value memo (cleared per current(); mirrors the from-scratch valCache) ──────
  #valCache = new Map<number, unknown>();

  // ── iteration memo (the incremental win) ──────────────────────────────────────
  readonly #iterCache = new Map<number, CachedIteration>();
  /** Generation of SHAPE-affecting signals: `loopBodies`, `recursiveHeads`, branch ROUTES.
   *  Bumped by `applyDelta` when any moves. A stale-gen iteration is recomputed — branch-
   *  flip (a scope crossing live threshold) turns a dissolved branch into a `<>` in EVERY
   *  iteration. TRACKS routes (not `liveBranchScopes.size`) — a streaming route shift can
   *  change the live SET without changing its size. EXCLUDES `pointIds`: a frozen iteration's
   *  point membership + operand wiring are fixed (new points get higher ids), so a new
   *  infer elsewhere does not invalidate it — keeps reuse near-total. */
  #shapeGen = 0;
  /** The `#shapeGen` the iteration cache was last validated against. */
  #cacheGen = -1;

  constructor(trace: EvalTrace) {
    this.#trace = trace;
  }

  /** `traceToRegions`-equivalent built via fold. Used by the parity test as reference. */
  static fromTrace(trace: EvalTrace): RegionGraph {
    const fold = new TraceRegionFold(trace);
    fold.applyDelta();
    return fold.current();
  }

  /**
   * Absorb every invocation minted since the last call (id ≥ cursor), in ascending id
   * order, extending the persistent state. Returns the number of new invocations.
   * O(Δ-new-invocations) — the whole point.
   */
  applyDelta(): number {
    // Slice new invocations by index cursor — O(Δ), not O(total) re-scan. Log is `enter`
    // order = ascending id (fold order), so slice is ordered (no sort).
    const log = this.#trace.invocationLog;
    const fresh: Invocation[] = log.slice(this.#logCursor);
    this.#logCursor = log.length;
    // Refresh running mirrors even with NO new invocations — an in-flight infer can
    // resolve (running → resolved) without minting; next `current()` must reflect it.
    this.#refreshRunning();
    if (fresh.length === 0) return 0;

    // ── pass 1: mirror each new invocation as a PlainInv (snapshotTrace's pass 1) ──
    for (const inv of fresh) {
      this.#liveById.set(inv.id, inv);
      const plain = this.#mirror(inv);
      this.#invById.set(inv.id, plain);
      if (plain.state === "running") this.#runningIds.add(inv.id);
      if (inv.parent === null) this.#rootIds.push(inv.id); // parentless top-level form
    }
    // ── pass 2: wire parent/children by id (both endpoints mirrored) ─────────────
    // A new invocation's parent may be OLD — link both directions.
    for (const inv of fresh) {
      const plain = this.#invById.get(inv.id)!;
      if (inv.parent) {
        const parentPlain = this.#invById.get(inv.parent.id) ?? null;
        plain.parent = parentPlain;
        // Append to parent's children IN INVOCATION ORDER. Process ascending id, so append
        // reproduces order — but a parent gains children across MULTIPLE deltas, so guard dup.
        if (parentPlain && !parentPlain.children.includes(plain)) parentPlain.children.push(plain);
      }
      // This invocation may also be the PARENT of an already-mirrored child (children have
      // higher ids; within one ascending pass the parent is seen first; across deltas a child
      // never precedes parent). Children of `inv` get linked at THEIR own pass-2 step.
    }
    // The snapshot keeps provenance only for children-of-points + roots. A child mirrored
    // before its parent was known to be a point would lack it. The membrane marks a
    // rosetta point only when its host fn SETTLES; hosts that stream (the studio's
    // inference planes) mark earlier, at the provider crossing — but that still leaves an
    // enter→crossing window (arg evaluation, which can itself contain a slow nested
    // point) in which a tick can mirror the parent as a non-point and its children
    // without provenance. `#refreshRunning` repairs both when the live flag flips
    // (`#promoteLatePoint`); the root case is stable (parentless from birth).

    // ── recursion + branch signals (extend the monotonic sets) ────────────────────
    this.#extendSignals(fresh);

    // ── loop spines (extend in O(Δ) so current() never re-DFSs the recursion) ──────
    this.#extendSpines(fresh);

    // ── points + Hasse edges (ascending id) ───────────────────────────────────────
    // New points, ascending id (sorted). A point's children's provenance refers only to
    // lower ids, so upstream closure is complete when processed.
    for (const inv of fresh) {
      if (!inv.isProvenancePoint) continue;
      const plain = this.#invById.get(inv.id)!;
      this.#points.push(plain);
      this.#pointIds.add(inv.id);
    }
    // Hasse edges/reach extended in ascending POINT id (topological order `addPointToHasse`
    // assumes). New points already ascending in `fresh`.
    for (const inv of fresh) {
      if (!inv.isProvenancePoint) continue;
      const plain = this.#invById.get(inv.id)!;
      const up = upstreamOfPoint(plain, this.#pointIds);
      const { edges: added } = addPointToHasse(plain.id, up, this.#reach);
      this.#baseEdges.push(...added);
    }

    return fresh.length;
  }

  /**
   * Materialize the current `RegionGraph`. Reuses frozen iterations through the memo so
   * only the growth frontier is re-walked; re-runs field-attribution + ports + the
   * statement-output over the (cheap) edge/region totals. Deep-equal to
   * `traceToRegions(trace)` for the same trace state.
   */
  current(): RegionGraph {
    // liveBranchScopes maintained by applyDelta (a CHANGE bumps #shapeGen).
    const liveBranchScopes = this.#liveBranchScopes;
    // Invalidate the iteration cache iff a SHAPE-affecting signal moved since last validated
    // (captured by `#shapeGen`, bumped in `applyDelta`).
    const gen = this.#shapeGen;
    if (gen !== this.#cacheGen) {
      this.#iterCache.clear();
      this.#cacheGen = gen;
    }

    // Fresh value memo per build (mirrors from-scratch `valCache`; parity with one-shot).
    // Live values are scheme-side — peel once with `toJS`; absent stays undefined.
    this.#valCache = new Map<number, unknown>();
    const valueById = (id: number): unknown => {
      if (this.#valCache.has(id)) return this.#valCache.get(id);
      const raw = this.#liveById.get(id)?.value;
      const v = raw === undefined ? undefined : toJS(raw);
      this.#valCache.set(id, v);
      return v;
    };
    const liveValueById = (id: number): SchemeValue | undefined => this.#liveById.get(id)?.value;
    // Mirror of from-scratch `liveProvenanceById`. MUST match one-shot exactly (parity).
    const liveProvenanceById = (id: number): Iterable<number> => this.#liveById.get(id)?.provenance ?? [];
    // Mirror of from-scratch `livePointsUnder`: topmost provenance points in invocation's
    // live subtree, for pluck-off-infer operands whose stamped value was GC-pruned. MUST match
    // one-shot exactly or parity test trips.
    const livePointsUnder = (id: number): number[] => {
      const root = this.#liveById.get(id);
      if (!root) return [];
      const out: number[] = [];
      const stack: Invocation[] = [...root.children];
      while (stack.length > 0) {
        const n = stack.pop()!;
        if (n.isProvenancePoint) {
          if (this.#pointIds.has(n.id)) out.push(n.id);
        } else stack.push(...n.children);
      }
      return out;
    };

    // Mirror of from-scratch `boundPointsOf` — sidecar scoped to live invocation's subtree,
    // narrowing-verdict pairing key. MUST match one-shot exactly (parity).
    const auto = this.#trace.autoBindings;
    const boundPointsOf = auto
      ? (id: number, name: string): readonly number[] => {
          const live = this.#liveById.get(id);
          return live ? (scopedBindings(auto, subtreeIds(live), [name])[name] ?? []) : [];
        }
      : undefined;

    const knotArm: { knot: number; arm: number }[] = [];
    const knotInputs: { knot: number; from: number }[] = [];

    // Iteration memo (the incremental seam). Freezable iteration: reuse cached template
    // (cloned) + replay knot wires; else compute fresh; if freezable, cache pristine clone +
    // knot delta produced.
    const iterationCache = (key: number, freezable: boolean, compute: () => Region[]): Region[] => {
      if (freezable) {
        const hit = this.#iterCache.get(key);
        if (hit?.gen === gen) {
          for (const k of hit.knotArm) knotArm.push(k);
          for (const k of hit.knotInputs) knotInputs.push(k);
          return cloneRegions(hit.template);
        }
      }
      const armBefore = knotArm.length;
      const inBefore = knotInputs.length;
      const regions = compute();
      if (freezable) {
        this.#iterCache.set(key, {
          template: cloneRegions(regions),
          knotArm: knotArm.slice(armBefore),
          knotInputs: knotInputs.slice(inBefore),
          gen,
        });
      }
      return regions;
    };

    // Cached loop spine (O(Δ) body-entry list). Falls back to from-scratch `walkSpine` when
    // no cached spine, so correctness never depends on cache — cache is purely optimization.
    const loopSpine = (entry: PlainInv): PlainInv[] => {
      const ids = this.#loopSpines.get(entry.id);
      if (ids === undefined) return walkSpine(entry);
      return ids.map((id) => this.#invById.get(id)!);
    };

    const ctx: RegionWalkCtx = {
      loopBodies: this.#loopBodies,
      liveBranchScopes,
      pointIds: this.#pointIds,
      valueById,
      liveValueById,
      liveProvenanceById,
      livePointsUnder,
      boundPointsOf,
      knotArm,
      knotInputs,
      iterationCache,
      loopSpine,
    };

    // Roots = top-level (parentless) forms, ascending id (= source order, matches
    // `snapshotTrace`'s `invocations`). Incremental: O(#roots), not O(N) re-filter.
    const tops = this.#rootIds.map((id) => this.#invById.get(id)!);
    const roots = tops.flatMap((t) => regionsAt(t, ctx));

    // Field attribution over COPY of base edges (from-scratch rewrites in place; keep
    // #baseEdges pristine for next tick).
    const finalizeCtx: FinalizeCtx = {
      points: this.#points,
      pointIds: this.#pointIds,
      reach: this.#reach,
    };
    // Consumer-slot then producer-output-row attribution — identical to from-scratch build
    // so `current()` deep-equals `traceToRegions` (parity gate).
    const edges = attributeFromFields(
      attributeFieldEdges(this.#baseEdges, finalizeCtx),
      carrierFieldEdges(this.#trace),
    );

    // Decision wires, then the statement-output terminal (final = last top-level form).
    appendDecisionEdges(edges, knotArm, knotInputs);
    appendOutput(roots, edges, tops.at(-1), finalizeCtx);

    // Stage 2a — container boundary ports (mutates the cloned/fresh fanout objects).
    derivePorts(roots, edges);

    return { roots, edges, warnings: [] };
  }

  // ── internals ─────────────────────────────────────────────────────────────────

  /** Re-read lifecycle fields of mirrors captured while running; once settled, refresh
   *  `state`/`value`/`metadata`/`provenance` to live values and drop from running set. Keeps
   *  the fold's mirror equal to a fresh `snapshotTrace` mid-flight. Reuses EXACT predicates
   *  `#mirror` (and `snapshotTrace`) apply.
   *
   *  NOTE (residual): a point whose ARGUMENT is a still-running infer (infer-as-infer-arg)
   *  could be added to the Hasse with an incomplete upstream; re-deriving point edges on a
   *  child's late provenance change is Phase-2. The common streaming shape (an infer reading
   *  PRIOR results via let-bindings) resolves its arg subtree before parking, so upstream is
   *  complete when first added. */
  #refreshRunning(): void {
    if (this.#runningIds.size === 0) return;
    for (const id of this.#runningIds) {
      const live = this.#liveById.get(id);
      const plain = this.#invById.get(id);
      if (!live || !plain) {
        this.#runningIds.delete(id);
        continue;
      }
      // LATE POINT PROMOTION — the mirror froze `isProvenancePoint` at ingest, but a
      // streaming host marks the point at the provider crossing, which can land AFTER a
      // tick ingested the invocation mid-arg-evaluation. Without promotion the leaf stays
      // invisible forever (the points pass walks only fresh invocations). Promote while
      // still running so the render shows the in-flight card, not just the settled one.
      if (live.isProvenancePoint && !plain.isProvenancePoint) this.#promoteLatePoint(live, plain);
      if (live.state === "running") continue; // in flight — re-check next tick.
      const isPoint = plain.isProvenancePoint;
      const isRoot = plain.parent === null;
      const isBranchChild = BRANCH_FORMS.has(this.#headName(plain.parent?.node) ?? "");
      plain.state = live.state;
      // Match `snapshotTrace`: peel at the plain-mirror boundary (scheme → JS once).
      plain.value =
        isPoint || isRoot || isBranchChild ? (live.value === undefined ? undefined : toJS(live.value)) : undefined;
      plain.metadata = isPoint ? live.metadata : undefined;
      // A leaf parked while `running` may have REJECTED since — re-copy error/cache so the
      // settled mirror matches a fresh snapshot.
      plain.error = isPoint && live.state === "rejected" ? errText(live.error) : undefined;
      plain.cached = isPoint ? live.cached : undefined;
      // Provenance materialized for children-of-points + roots (snapshot predicate);
      // computed at live invocation's exit, so re-copy now it has settled.
      if (plain.parent?.isProvenancePoint || isRoot) plain.provenance = new Set(live.provenance);
      this.#runningIds.delete(id);
    }
  }

  /** Repair a mirror whose live invocation was marked a provenance point AFTER ingest
   *  (see `#refreshRunning`). Flips the mirror's flag + metadata, re-copies its direct
   *  children's provenance (frozen EMPTY while the parent read as a non-point — exactly
   *  what `upstreamOfPoint` reads), and inserts the point into `#points`/`#baseEdges` at
   *  its ascending-id position so the fold's output stays deep-equal to the from-scratch
   *  build. Downstream Hasse entries need no re-derivation: the promotion happens while
   *  the point is still unresolved, so no later point can have consumed its output yet
   *  (the infer-as-infer-arg upstream residual noted above is unchanged). */
  #promoteLatePoint(live: Invocation, plain: PlainInv): void {
    plain.isProvenancePoint = true;
    plain.metadata = live.metadata;
    for (const child of plain.children) {
      const liveChild = this.#liveById.get(child.id);
      if (liveChild) child.provenance = new Set(liveChild.provenance);
    }
    const points = this.#points;
    let i = points.length;
    while (i > 0 && points[i - 1]!.id > plain.id) i--;
    points.splice(i, 0, plain);
    this.#pointIds.add(plain.id);
    const up = upstreamOfPoint(plain, this.#pointIds);
    const { edges: added } = addPointToHasse(plain.id, up, this.#reach);
    // Base edges stay grouped ascending by target point (parity with from-scratch).
    const edges = this.#baseEdges;
    let j = edges.length;
    while (j > 0 && edges[j - 1]!.to > plain.id) j--;
    edges.splice(j, 0, ...added);
  }

  /** Mirror ONE live invocation as `snapshotTrace` pass 1 does: scalar fields + pre-derived
   *  `scope` + selective provenance/value/metadata materialization. Parent/children wired in
   *  pass 2 (`applyDelta`). */
  #mirror(inv: Invocation): PlainInv {
    const isPoint = inv.isProvenancePoint;
    const isRoot = inv.parent === null;
    const isBranchChild = BRANCH_FORMS.has(this.#headName(inv.parent?.node) ?? "");
    return {
      id: inv.id,
      node: inv.node,
      scope: scopeId(inv.node),
      parent: null,
      children: [],
      provenance: inv.parent?.isProvenancePoint || isRoot ? new Set(inv.provenance) : EMPTY_NUM,
      isProvenancePoint: isPoint,
      // Match `snapshotTrace`: peel at the plain-mirror boundary (scheme → JS once).
      value: isPoint || isRoot || isBranchChild ? (inv.value === undefined ? undefined : toJS(inv.value)) : undefined,
      metadata: isPoint ? inv.metadata : undefined,
      state: inv.state,
      error: isPoint && inv.state === "rejected" ? errText(inv.error) : undefined,
      cached: isPoint ? inv.cached : undefined,
    };
  }

  /** Head name of a live Pair (the snapshot's `headName` helper, inlined). */
  #headName(node: APair<SchemeValue, SchemeValue> | undefined): string | undefined {
    const car = (node as { car?: unknown } | undefined)?.car;
    const n = (car as { __name__?: unknown } | undefined)?.__name__;
    return typeof n === "string" ? n : undefined;
  }

  /** Extend recursion + branch-liveness signal sets. STATIC loop/recursion readers depend
   *  only on `(define …)` → re-run only on define; DYNAMIC scans (`hasSelfAncestor`) per new
   *  inv; branch routes per new branch invocation. All monotonic. */
  #extendSignals(fresh: Invocation[]): void {
    const headsBefore = this.#recursiveHeads.size;
    const bodiesBefore = this.#loopBodies.size;
    // Did a define arrive? (static recursion readers depend on defines.)
    for (const inv of fresh) {
      if (headOf(this.#invById.get(inv.id)!) === "define") {
        this.#pendingDefine = true;
        break;
      }
    }
    // Re-run static readers over ALL mirrored invocations when define pending. Idempotent
    // (Set), bounded by define count not N (GEPA trace has 3 defines, scanned once).
    if (this.#pendingDefine) {
      const all = [...this.#invById.values()];
      for (const h of staticRecursiveHeads(all)) this.#recursiveHeads.add(h);
      for (const b of staticLoopBodyScopes(all)) this.#loopBodies.add(b);
      this.#pendingDefine = false;
    }
    // Dynamic recursive-head scan (an application recurring on its own ancestor chain).
    for (const inv of fresh) {
      const plain = this.#invById.get(inv.id)!;
      if (STRUCTURAL_FORMS.has(headOf(plain))) continue;
      if (hasSelfAncestor(plain)) this.#recursiveHeads.add(headOf(plain));
    }
    // Dynamic loop-body scan (a re-entrant body under a recursive-head call).
    for (const inv of fresh) {
      const plain = this.#invById.get(inv.id)!;
      if (plain.parent && hasSelfAncestor(plain) && this.#recursiveHeads.has(headOf(plain.parent))) {
        this.#loopBodies.add(plain.node as object);
      }
    }
    // Branch-route liveness (LAST evaluated child's node = taken route). A route can CHANGE
    // across deltas (last child shifts as arm fills), so recompute for every branch inv
    // touched this delta (a branch in `fresh`, or OLD branch whose child set grew). Route
    // stored PER INVOCATION so a shift REPLACES the prior (no stale accumulation) — keeps
    // `liveBranchScopes` identical to a fresh scan.
    const branchTouched = new Set<number>();
    for (const inv of fresh) {
      const plain = this.#invById.get(inv.id)!;
      if (BRANCH_FORMS.has(headOf(plain))) branchTouched.add(plain.id);
      const par = plain.parent;
      if (par && BRANCH_FORMS.has(headOf(par))) branchTouched.add(par.id);
    }
    // Transient memo for operand-value reads `decisionInputProducers` needs (live scheme → toJS).
    const valCache = new Map<number, unknown>();
    const valueById = (vid: number): unknown => {
      if (valCache.has(vid)) return valCache.get(vid);
      const raw = this.#liveById.get(vid)?.value;
      const v = raw === undefined ? undefined : toJS(raw);
      valCache.set(vid, v);
      return v;
    };
    const renderableBefore = this.#renderableBranchScopes();
    for (const id of branchTouched) {
      const plain = this.#invById.get(id)!;
      const scope = scopeId(plain.node);
      (this.#branchInvsByScope.get(scope) ?? this.#branchInvsByScope.set(scope, new Set()).get(scope)!).add(id);
      this.#branchRouteByInv.set(id, routeOf(plain));
      // Dynamic-capability — EXACTLY `regionsAt`'s wired test (live∩dynamic = scopes that
      // render `<>`). Wiredness is a SOURCE-structure property, SAME per scope — check ONCE
      // per scope (`#isWired` is O(depth), so checking all 1000 loop-`if` invocations is
      // O(N²)). Mark "checked" only when DETERMINATE: if any tested operand's producer is
      // still RUNNING, its provenance may be unstamped — re-check next delta (keeps streaming
      // verdict sound for a branch fed by an in-flight infer).
      if (!this.#wiredChecked.has(scope)) {
        if (this.#isWired(plain, valueById)) {
          this.#dynamicCapableScopes.add(scope);
          this.#wiredChecked.add(scope);
        } else if (this.#operandsResolved(plain)) {
          this.#wiredChecked.add(scope);
        }
      }
    }
    // Recompute live-branch scope set (sparse). Scope live iff its invocations span ≥2
    // DISTINCT current routes (exactly `branchLiveness`).
    const liveBranchScopes = new Set<string>();
    for (const [scope, invs] of this.#branchInvsByScope) {
      const routes = new Set<object>();
      for (const invId of invs) {
        const r = this.#branchRouteByInv.get(invId);
        if (r !== undefined) routes.add(r);
        if (routes.size >= 2) break;
      }
      if (routes.size >= 2) liveBranchScopes.add(scope);
    }
    this.#liveBranchScopes = liveBranchScopes;
    // Bump shape generation iff a SHAPE-affecting signal moved — new loop body / recursive
    // head, or change in RENDERABLE branch set (live ∩ dynamic-capable). A liveBranchScopes
    // change for a STATIC (dissolving) branch alters no region, so must NOT invalidate the
    // cache — prevents the terminal-iteration full re-walk on the GEPA loop's static tail-`if`.
    const renderableChanged = !sameStringSet(this.#renderableBranchScopes(), renderableBefore);
    if (this.#recursiveHeads.size !== headsBefore || this.#loopBodies.size !== bodiesBefore || renderableChanged) {
      this.#shapeGen += 1;
    }
  }

  /** Scopes that render a `<>`: live AND dynamic-capable. Cache invalidates only when THIS
   *  set changes (region shape depends on it, not raw liveBranchScopes — a dissolving static
   *  branch flattens identically live-or-not). */
  #renderableBranchScopes(): Set<string> {
    const out = new Set<string>();
    for (const scope of this.#liveBranchScopes) if (this.#dynamicCapableScopes.has(scope)) out.add(scope);
    return out;
  }

  /** ≥1 tested operand traces to an infer point — EXACTLY `regionsAt`'s `wired.size > 0`. */
  #isWired(inv: PlainInv, valueById: (id: number) => unknown): boolean {
    for (const { producerId } of decisionInputProducers(inv, valueById)) {
      if (this.#pointIds.has(producerId)) return true;
      for (const p of valueProvenance(this.#liveById.get(producerId)?.value)) {
        if (this.#pointIds.has(resolveOriginVia(p))) return true;
      }
    }
    return false;
  }

  /** Every operand producer SETTLED (not running) — "not wired" verdict is final
   *  (provenance won't grow). Decides whether to lock in or defer the dynamic-capability check. */
  #operandsResolved(inv: PlainInv): boolean {
    const valueById = (vid: number): unknown => {
      const raw = this.#liveById.get(vid)?.value;
      return raw === undefined ? undefined : toJS(raw);
    };
    for (const { producerId } of decisionInputProducers(inv, valueById)) {
      if (this.#liveById.get(producerId)?.state === "running") return false;
    }
    return true;
  }

  /** Extend per-loop body-entry spines in O(Δ). For each NEW body-entry, link to its loop's
   *  spine: nearest same-body ancestor (previous iteration's entry) found by bounded walk
   *  (one iteration's depth, NOT spine length), append to THAT entry's spine. No same-body
   *  ancestor → STARTS a new spine. Reconstructs the `nextSameBody` chain (inverse: B's
   *  nearest same-body ancestor P ⟺ B = nextSameBody(P)), so `current()` reads the spine
   *  instead of re-DFSing — turns the otherwise-O(N)-per-build walk into O(spine length). */
  #extendSpines(fresh: Invocation[]): void {
    for (const inv of fresh) {
      const plain = this.#invById.get(inv.id)!;
      if (!this.#loopBodies.has(plain.node as object)) continue;
      // Nearest same-body ancestor (the previous iteration's body-entry), bounded depth.
      let p: PlainInv | null = plain.parent;
      while (p && p.node !== plain.node) p = p.parent;
      if (p) {
        // A later iteration: append to the loop's spine owned by p's entry.
        const entryId = this.#bodyEntryOf.get(p.id);
        if (entryId !== undefined) {
          this.#bodyEntryOf.set(plain.id, entryId);
          this.#loopSpines.get(entryId)?.push(plain.id);
        }
        // ELSE p mirrored BEFORE its node became a loop body (dynamic detection), so the
        // true entry is unrecorded — DON'T start a spurious spine. `current()` sees no spine
        // for the true entry and falls back to `walkSpine`.
        continue;
      }
      // First body-entry of a loop instance → start a new spine.
      this.#bodyEntryOf.set(plain.id, plain.id);
      this.#loopSpines.set(plain.id, [plain.id]);
    }
  }
}
