/**
 * pending-entry.ts — the LAZY PENDING CELL for a Promise-valued entry inside a structure
 * (an AJSObject/ADict entry, an AJSArray element).
 *
 * LAW: native spine carriers (AVector/APair) never hold pending cells — their elements
 * are owned `SchemeValue`s structurally, so this machinery is ADict/AJSObject/AJSArray
 * ONLY. A raw scheme Promise inside a native vector/list egresses through
 * egressUnknown's FFI passthrough as the Promise itself, by design — ADict's
 * settle-then-project egress branch is law, not an oversight the other containers miss.
 *
 * Design (utils/promises.ts header): structures hold promise-valued members INERT; the
 * interpreter awaits lazily at the seam where the value is actually NEEDED. For container entries that seam is the ENTRY READ (tagless get /
 * `@` / `dict-ref` / `vector-ref` / toJS materialization) — this helper is `maybeThen`'s
 * discipline (sync-stays-sync, ONE promise, never a structure traversal) specialized to
 * that seam, plus the settle-cache hook the containers need:
 *
 *  - a still-pending entry read mints ONE settle chain and the caller caches the CHAIN
 *    itself in its entry slot, so concurrent readers share a single settlement;
 *  - on settlement the chain boxes the value and hands it to `onSettled`, which
 *    overwrites the slot with the settled box — every later read is synchronous
 *    (sync-after-settled);
 *  - a raw Promise NEVER leaks into scheme space from an entry read: the reader gets
 *    either the settled box or a Promise OF the box (which the evaluator's async seams
 *    already await).
 *
 * Imports `is_promise` from value-guards like APair/AVector already do (thenable-aware,
 * not just native-Promise instanceof).
 */
import { is_promise } from "../value-guards.js";
import type { SchemeValue } from "../types.js";

/** The live settle chains — lets a caller whose entry SLOT doubles as the cell cache
 *  (ADict stores the chain back into `byKey`) tell "an already-minted cell" apart from
 *  "a raw pending entry", so a re-read during pendency returns the SAME chain instead
 *  of wrapping a second one (the ONE-settle-chain contract). */
const chains = new WeakSet<Promise<SchemeValue>>();

/** True iff `v` is a settle chain minted by `settleEntry` (still pending or not yet
 *  overwritten by its `onSettled` hook). */
export function isSettleChain(v: unknown): v is Promise<SchemeValue> {
  return v instanceof Promise && chains.has(v);
}

export function settleEntry(
  raw: unknown,
  box: (settled: unknown) => SchemeValue,
  onSettled: (boxed: SchemeValue) => void,
): SchemeValue | Promise<SchemeValue> {
  if (!is_promise(raw)) return box(raw);
  const chain = Promise.resolve(raw).then((settled) => {
    const boxed = box(settled);
    onSettled(boxed);
    return boxed;
  });
  chains.add(chain);
  return chain;
}
