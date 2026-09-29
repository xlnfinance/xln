/**
 * Evaluator-side emission hook: port sites (membrane penetrations — rosetta
 * exits, source-roled mints) inside `src/eval/*`. Owns the ambient "current
 * record coordinate" a caller installs so a membrane crossing inside
 * evaluator.ts's generic apply can key an emission, plus the one call site
 * that fires it. Same ambient-holder + save/restore idiom as
 * dynamic-call-site.ts.
 *
 * WHY NOT STRUCTURAL DETECTION: rosetta mint paths flip
 * `inv.isProvenancePoint` when an invocation id is live. This hook reuses that
 * signal after the fact — a detached sidecar, not a special-case of every apply.
 *
 * DETACHED, NOT INLINE: `notePotentialRosettaExit` never wraps or awaits the
 * value/Promise the trampoline yields — it attaches its own independent
 * `.then`/`.catch` (or runs sync off to the side) so a slow/failed emission
 * never perturbs the real call's timing, identity, or outcome.
 */
import { assertSingleLoad } from "../single-load.js";
import type { Invocation } from "./dynamic-call-site.js";
import { is_promise } from "../values/value-guards.js";
import { emitMint, isEmissionEnabled } from "../provenance/store/emit.js";
import type { OrdinalPath, RegionEpoch, RegionId, TemplateHash } from "../provenance/store/ids.js";
import type { PayloadStore, ProvenanceStore } from "../provenance/store/interfaces.js";
import { AValue } from "../values/primitives/AValue.js";
import { isSilentRegion } from "../membrane/region-scope.js";
import { toJS } from "../membrane/rosetta.js";
import type { SchemeValue } from "../values/types.js";

/** One port's static address — everything an emission needs BESIDES which
 *  store/region to write to (`EmissionSink`). */
export interface RecordCoordinate {
  readonly templateHash: TemplateHash;
  readonly ordinalPath: OrdinalPath;
  readonly regionEpoch: RegionEpoch;
}

/** Where a coordinate's records land — store ports + region partition. Split
 *  from RecordCoordinate (per-port address) because one sink typically serves
 *  many coordinates across a region's lifetime. */
export interface EmissionSink {
  readonly store: ProvenanceStore;
  readonly payloads: PayloadStore;
  readonly regionId: RegionId;
}

// EXTENT (docs/execution.md §HERMETIC, audit S1): this holder is per-ISOLATE, not
// per-run — at most one recording run may be live on this isolate at a time. Two
// concurrently recording runs would interleave each other's coordinate/sink through
// this pair, mis-attributing emissions. Save/restore (below) makes NESTING safe
// (a recording run started inside another recording run's install correctly restores
// the parent's pair on exit); it does not make CONCURRENT recording safe. If that
// stops being a real constraint, the upgrade path is keying this pair by `RunContext`
// identity instead of holding it ambient.
//
// Module-local (not globalThis). A second evaluation of this file would split the
// pair — detected at load.
assertSingleLoad("eval/provenance-hooks");

let _coordinate: RecordCoordinate | undefined;
let _sink: EmissionSink | undefined;

/** Install coordinate + sink for `fn` — save/restore. Nested install restores
 *  the parent pair on exit. Restores only after `fn`'s returned Promise settles,
 *  so every crossing during a multi-tick run still observes the install. */
export async function withRecordCoordinateAsync<T>(
  coordinate: RecordCoordinate,
  sink: EmissionSink,
  fn: () => Promise<T>,
): Promise<T> {
  const savedCoordinate = _coordinate;
  const savedSink = _sink;
  _coordinate = coordinate;
  _sink = sink;
  try {
    return await fn();
  } finally {
    _coordinate = savedCoordinate;
    _sink = savedSink;
  }
}

/** Structural shape of the per-invocation mint flag — opaque Invocation
 *  narrowed structurally (provenance/trace.ts owns the real shape). */
interface ProvenancePointInvocation {
  readonly id?: number;
  readonly isProvenancePoint?: boolean;
}

/** Peel a settled call result into a mint's payload shape — one membrane exit. */
function payloadOf(value: SchemeValue): { readonly value: unknown; readonly stampIds: readonly number[] } {
  const stampIds = value instanceof AValue ? [...value.provenance] : [];
  return { value: toJS(value), stampIds };
}

/**
 * THE hook — call once from evaluator.ts's generic apply site after a call's
 * result is known (plain value or pending Promise; NEVER a Bounce).
 *
 * No-ops unless: emission flag on, coordinate AND sink installed, and `inv`
 * names a live invocation — one boolean read on the hot path when disabled.
 */
export function notePotentialRosettaExit(inv: Invocation, result: SchemeValue | Promise<SchemeValue>): void {
  if (!isEmissionEnabled()) return;
  // Silent region (γ / glass whole-program replay) suppresses this mint —
  // separate ambient from _coordinate/_sink (membrane/region-scope.ts).
  if (isSilentRegion()) return;
  const coordinate = _coordinate;
  const sink = _sink;
  if (coordinate === undefined || sink === undefined) return;
  const point = inv as ProvenancePointInvocation | undefined;
  if (point === undefined || typeof point.id !== "number") return;

  const id = {
    templateHash: coordinate.templateHash,
    ordinalPath: coordinate.ordinalPath,
    regionEpoch: coordinate.regionEpoch,
  };

  const settle = (value: SchemeValue): void => {
    // Read AFTER settlement — rosetta mint flips this flag synchronously before
    // the wrapper Promise resolves.
    if (point.isProvenancePoint !== true) return;
    const { value: peeled, stampIds } = payloadOf(value);
    // Fire-and-forget sidecar: production correctness never depends on this
    // write. Direct emitMint is the durability seam; this path swallows failures.
    void emitMint({
      store: sink.store,
      payloads: sink.payloads,
      regionId: sink.regionId,
      id,
      value: peeled,
      stampIds,
    }).catch(() => {});
  };

  if (is_promise(result)) {
    void (result as Promise<SchemeValue>).then(settle, () => {}); // rejected crossing mints nothing
  } else {
    settle(result);
  }
}
