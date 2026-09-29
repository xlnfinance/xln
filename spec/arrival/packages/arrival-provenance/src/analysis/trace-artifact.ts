/**
 * The TRACE PROTOCOL — the open-core boundary (ADR-019).
 *
 * The runner emits a `TraceArtifact`; the visualizer reads it. Neither side
 * reaches across the seam for anything else. The artifact is a `RegionGraph`
 * (the blueprint structure `traceToRegions` already produces) carried as a
 * SETTLED, JSON-safe value, plus a `version` so the format can evolve under an
 * explicit compatibility discipline (additive-by-default; a breaking change
 * bumps the version and the visualizer supports the window).
 *
 * Membrane discipline — peel once, at the snapshot:
 *   `snapshotTrace` is the scheme→JS boundary (`toJS` on `PlainInv.value`;
 *   `metadata` is host-side POJO and never crosses into scheme). `traceToRegions`
 *   copies those already-plain fields onto leaf/output regions. This serializer
 *   does NOT re-cross the membrane — a second peel would be the soft-idempotent
 *   smell (`toJS` on mixed world). Fanout structure is cloned so the
 *   artifact owns its tree; no AValue should remain after the snapshot boundary.
 *
 * `serializeTrace` / `loadTraceArtifact` are the ONLY format-aware functions —
 * the SERDE discipline used for `GlobalVariant` in `token-variance.ts`. Keep all
 * version-gating here; downstream consumers take `{ graph }` and never branch on
 * the wire shape.
 */
import { ArrivalError, type ErrorClass } from "@inhuman.tools/arrival";

import { traceToRegions, type Region, type RegionGraph } from "./trace-to-regions.js";
import type { EvalTrace } from "@inhuman.tools/arrival/provenance";

/**
 * A `TraceArtifact` was produced by a newer protocol version than this
 * visualizer supports (`loadTraceArtifact` below) — rejected loudly rather
 * than rendered wrong; there is no older format to migrate from yet.
 *
 * Moved here from arrival core's `errors.ts` (provenance analysis-stack
 * relocation): `trace-artifact.ts` is its sole thrower, and nothing in core
 * ever caught it by identity — the door travels with its thrower. Message/
 * shape preserved byte-identically.
 */
export class TraceArtifactVersionError extends ArrivalError {
  public readonly name = "TraceArtifactVersionError";
  readonly "arrival/error-category": ErrorClass = "other";

  constructor(
    public readonly version: number,
    public readonly maxVersion: number,
  ) {
    super(
      `Trace artifact version ${version} is newer than this visualizer supports (${maxVersion}). Update the visualizer.`,
    );
  }
}

/**
 * The wire-format version. Bump ONLY on a breaking change to the artifact shape
 * (a removed/renamed field, a changed value encoding). Additive fields — a new
 * optional region property, a new edge kind — do NOT bump it: old visualizers
 * ignore what they don't read, new ones tolerate its absence.
 */
export const TRACE_PROTOCOL_VERSION = 1;

/**
 * The on-the-wire trace. Everything the free visualizer needs from a run —
 * a settled `RegionGraph`, JSON-safe, self-describing by `version`. No cells
 * sidecar: leaf/output regions already carry their settled `value`/`state`
 * inline, and `RegionGraphView`'s `cells` prop is optional (the no-live-cells
 * path `shell.tsx` already renders from).
 */
export interface TraceArtifact {
  /** Matches `TRACE_PROTOCOL_VERSION` at emit time. */
  version: number;
  /** The blueprint structure — plain JS from the snapshot membrane exit. */
  graph: RegionGraph;
}

/**
 * Own the region tree so later live-trace mutation cannot touch the artifact.
 * Values/meta are already plain; only fanout nesting needs structural copy.
 */
function cloneRegion(region: Region): Region {
  switch (region.kind) {
    case "fanout":
      return { ...region, iterations: region.iterations.map((body) => body.map(cloneRegion)) };
    case "leaf":
    case "output":
    case "decision":
      return { ...region };
  }
}

/**
 * Emit a `TraceArtifact` from a finished `EvalTrace`. Graph construction
 * (`traceToRegions` → `snapshotTrace`) already exited the membrane; this only
 * versions + owns the tree. The only emitter-side format-aware function.
 */
export function serializeTrace(trace: EvalTrace): TraceArtifact {
  const graph = traceToRegions(trace);
  return {
    version: TRACE_PROTOCOL_VERSION,
    graph: { ...graph, roots: graph.roots.map(cloneRegion) },
  };
}

/**
 * Read a `TraceArtifact` into the `{ graph }` the visualizer mounts. The only
 * consumer-side format-aware function: gate on `version` here so the renderer
 * never branches on the wire shape. A future major-version artifact is rejected
 * loudly rather than rendered wrong.
 */
export function loadTraceArtifact(artifact: TraceArtifact): { graph: RegionGraph } {
  if (artifact.version > TRACE_PROTOCOL_VERSION) {
    throw new TraceArtifactVersionError(artifact.version, TRACE_PROTOCOL_VERSION);
  }
  // v1 is the floor — no older format exists to migrate from yet. When one does,
  // migrate-forward by version here (additive fields need no migration).
  return { graph: artifact.graph };
}
