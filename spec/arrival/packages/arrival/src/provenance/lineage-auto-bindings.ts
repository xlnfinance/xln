/**
 * The AUTO-BINDING runtime leaf-stamp. ADDITIVE + flag-gated.
 *
 * PROBLEM: a manually-assembled `{ infer: inferIds }` global name→ids map COLLAPSES
 * the distinct invocations of one source name — `(map infer xs)` over 3 elements
 * mints 3 producer ids, but the static tree has one `infer` node, so the map can't
 * say "THIS element-projection reads producer `b` specifically" — exactly the
 * distinction the dag's causal edges need.
 *
 * FIX: bind PER-VALUE / PER-INVOCATION, never per-name. Each value already carries
 * its producer id(s) in `AValue.provenance` (stamped by `EvalTrace.exit`), so the
 * auto-binding does not mint a new id — it CAPTURES the producer ids a runtime value
 * carries, keyed to the CONSUMER INVOCATION that read it, not to a global slot. When
 * `reflect`'s body reads `reactions` (bound to `(list (react …))`), the capture
 * scoped to that invocation records `reactions → {react's id}`, never reflect's own
 * infer id (unreachable from the `reactions` value) — the aliasing dissolves because
 * each capture is scoped to one invocation's symbol resolutions.
 *
 * Generalizes the `argProvenance → buildInputsProvenance`
 * `slot→producer-id[]` map (rosetta.ts's `argProvenance` capture +
 * llm-plane-arrival-env/prompt.ts's `buildInputsProvenance`) — same shape, built for the
 * carrier's free leaf slots from `deepProvenance(symbol-value)` instead of `.prompt` kwargs.
 *
 * HOOK. An `AutoBindings` instance attaches to an `EvalTrace` explicitly
 * (flag-gated); when present, `exit` records the invocation's symbol resolutions
 * into it, and when absent the trace touches nothing.
 */
import { deepProvenance } from "./deep-provenance.js";
import type { Bindings, LineageNode } from "./lineage.js";

/** The free LEAF/SOURCE slots a classified skeleton references — the slots an auto-binding
 *  must resolve. Duplicates lineage-shadow.ts's `collectSlots` (kept here so this module
 *  stays self-contained). Descends a `field`'s focused child
 *  only — siblings were pruned at classify.
 *
 *  DIVERGES from `collectSlots`: the `fan` arm here ALSO descends `n.template` (the
 *  per-element body's free slots), so this collects strictly MORE slots — any free var
 *  captured inside a `(map (lambda (e) … outer …) xs)` body. Intentional (those slots need
 *  per-value resolution too); when folded into `walk` in M1, keep this superset. */
export function slotsOf(n: LineageNode, out: Set<string> = new Set()): Set<string> {
  switch (n.kind) {
    case "literal":
      return out;
    case "leaf":
      out.add(n.slot);
      return out;
    case "source":
      out.add(n.op);
      return out;
    case "pipe":
    case "field":
    case "transparent": // cone-identical to pipe (transparent neither mints nor stamps) — UNREACHABLE today
      slotsOf(n.child, out);
      return out;
    case "fan":
      slotsOf(n.source, out);
      if (n.template) slotsOf(n.template, out);
      return out;
    case "mux":
      slotsOf(n.selector, out);
      n.arms.forEach((a) => slotsOf(a, out));
      return out;
    case "merge":
    case "opaque":
    case "sink": // children-array shape, same barrier treatment — UNREACHABLE today
    case "binder": // children-array shape, same barrier treatment — UNREACHABLE today
      n.children.forEach((ch) => slotsOf(ch, out));
      return out;
  }
}

/**
 * The additive, flag-gated AUTO-BINDING sidecar. Populated by `EvalTrace.exit` (only when
 * an instance is attached — otherwise the trace never touches it). Records, PER CONSUMER
 * INVOCATION, the producer ids each symbol it resolved carries — the per-value binding the
 * carrier's `fieldResolve` needs, scoped so distinct invocations of one source name never
 * collapse.
 *
 * NOT a global `name → ids` map: the outer key is the consumer INVOCATION id, the inner map
 * is that invocation's `slot → producer-ids`. The same source name (`infer`) read in two
 * invocations lands under two distinct invocation ids with its own per-call producer set —
 * the structure the dag's distinct-invocation edges need.
 */
export class AutoBindings {
  /** consumer-invocation id → (free-symbol slot → the producer ids that slot's runtime
   *  value carried, at THIS invocation).
   *
   *  RETENTION CAVEAT (flag-ON only): holds O(invocations-that-resolved-a-provenanced-
   *  symbol) entries for the whole run — does NOT participate in
   *  `EvalTrace.#pruneChildProvenance`'s mid-run shedding. Fine for today's bounded
   *  programs; before a real LOOPING run, either pruning should also drop the
   *  `byInvocation` entry for a pruned invocation, or capture should scope to the
   *  queries that will actually read it. */
  readonly byInvocation = new Map<number, Map<string, Set<number>>>();

  /**
   * Record one invocation's symbol resolutions (the leaf-stamp), called from the trace's
   * `exit` with the invocation id and the `name → value` map already captured in
   * `symbolValues`. For each resolved symbol carrying provenance, store its deep producer
   * ids under this invocation; empty-provenance symbols are skipped.
   */
  recordInvocation(invocationId: number, symbolValues: ReadonlyMap<string, unknown> | undefined): void {
    if (!symbolValues || symbolValues.size === 0) return;
    let slots: Map<string, Set<number>> | undefined;
    for (const [name, value] of symbolValues) {
      const ids = deepProvenance(value);
      if (ids.size === 0) continue;
      if (!slots) {
        slots = this.byInvocation.get(invocationId) ?? new Map();
        this.byInvocation.set(invocationId, slots);
      }
      const existing = slots.get(name);
      // DEFENSIVE merge: the live caller passes a `symbolValues` Map (unique keys) once per
      // invocation, so `existing` is undefined in practice; fires only if a future caller
      // re-records a name into the same invocation. `ids` is a ReadonlySet, so the
      // per-invocation map owns a mutable copy.
      if (existing) for (const id of ids) existing.add(id);
      else slots.set(name, new Set(ids));
    }
  }

  /** Find the invocation that resolved `slot` and read its producer ids — the per-value
   *  binding for a carrier leaf. When several invocations resolved the same slot (a slot
   *  read in a loop), `pick` selects one; default = the FIRST recorded (lowest invocation
   *  id). Returns `[]` if no invocation carried producer ids for the slot. */
  producersFor(slot: string, pick?: (candidates: { invocationId: number; ids: Set<number> }[]) => number[]): number[] {
    const candidates: { invocationId: number; ids: Set<number> }[] = [];
    for (const [invocationId, slots] of this.byInvocation) {
      const ids = slots.get(slot);
      if (ids && ids.size > 0) candidates.push({ invocationId, ids });
    }
    if (candidates.length === 0) return [];
    if (pick) return [...pick(candidates)].toSorted((a, z) => a - z);
    const ordered = candidates.toSorted((a, z) => a.invocationId - z.invocationId);
    return [...ordered[0]!.ids].toSorted((a, z) => a - z);
  }

  /**
   * Assemble a `Bindings` for a classified skeleton's free LEAF/SOURCE slots — the auto
   * analogue of `bindingsForSkeleton` (lineage-shadow.ts), but each slot resolves to
   * the producer ids the RUNTIME VALUE carried (per-value), not `provOf(env.get(slot))`
   * (which reads the top-level env where a lambda-param leaf like `reactions` isn't even
   * bound). `slots` is the set the skeleton references (the consumer reads it off
   * `classify`'s tree via `collectSlots`).
   */
  bindingsFor(slots: Iterable<string>): Bindings {
    const b: Record<string, readonly number[]> = {};
    for (const slot of slots) {
      const ids = this.producersFor(slot);
      if (ids.length > 0) b[slot] = ids;
    }
    return b;
  }
}
