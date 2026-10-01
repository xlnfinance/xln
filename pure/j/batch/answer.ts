// The other half of the page: what the chain said about the batches the Entity signed, and what to do when it says
// nothing.
//
//   observe  a J fact about one of our batches. A landed batch is done: the ops it names are applied or skipped, and a
//            copy of one waiting in the draft is dropped. A failed batch (R-J5) applied nothing and spent its nonce, so
//            its work goes back to the draft at a fresh nonce, except the co-signed ops: those are RETURNED to their
//            Account, because the counterparty's signature is what failed and a resend would fail the same way.
//   abort    stop waiting for the sent batch. It stays signed and may still land (F1), so it becomes abandoned; only
//            ops that are safe to send twice go back to the draft, a deposit or a payment stays with it.
//   landable the signed batch the chain accepts next, if we hold it: a resend of the sent one, or a push of an
//            abandoned one that must land before anything signed above it can.
import { none, orElse, some, type Option } from "../../kernel/core/option.ts";
import { match, type Tagged } from "../../kernel/core/tagged.ts";
import { fitFault, type FitFault } from "../plan/fit.ts";
import { isCosigned, isIdempotent, requestKey, type JOp } from "../op/ops.ts";
import { LANDED_MEMORY, submitted, type JBatch } from "./jbatch.ts";
import type { SealedBatch } from "./sealed.ts";

/** `DisputeOpSkipped(sender, counterentity, op, reason, nonce)`: op 0 start, 1 counter, 2 finalize (3 is a ladder). */
export type SkipFact = Readonly<{ op: number; counterentity: string; reason: number; nonce: bigint }>;

/** What the Host reads off the chain about one of our batches. */
export type JAnswer =
  | Tagged<"landed", { nonce: bigint; batchHash: string; skipped: readonly SkipFact[] }>
  | Tagged<"failed", { nonce: bigint; reason: string }>
  | Tagged<"starved", { nonce: bigint }>;

export type ReturnReason =
  | Tagged<"batch_failed", { reason: string }>
  | Tagged<"draft_full", { fault: FitFault }>;

/** An op the Entity hands back to whoever queued it, with the reason: a new signature or a new request is theirs. */
export type Returned = Readonly<{ op: JOp; because: ReturnReason }>;

/** A dispute op the chain skipped as stale (J2): its batch landed and it did nothing, and its Account is told why. */
export type Skipped = Readonly<{ op: JOp; reason: number }>;

export type Observed = Readonly<{ jbatch: JBatch; returned: readonly Returned[]; skipped: readonly Skipped[] }>;

const unchanged = (jbatch: JBatch): Observed => ({ jbatch, returned: [], skipped: [] });

const signed = (j: JBatch): readonly SealedBatch[] =>
  [...(j.phase._tag === "inflight" ? [j.phase.sent] : []), ...j.abandoned];

const larger = (a: bigint, b: bigint): bigint => (a > b ? a : b);

/** The batch is no longer waiting: not the one sent, not an abandoned one. */
const without = (j: JBatch, batch: SealedBatch): JBatch => ({
  ...j,
  phase: j.phase._tag === "inflight" && j.phase.sent === batch ? { _tag: "idle" } : j.phase,
  abandoned: j.abandoned.filter((b) => b !== batch),
});

const sameKey = (op: JOp, keys: ReadonlyMap<string, JOp> | ReadonlySet<string>): boolean =>
  keys.has(orElse(requestKey(op), ""));

const isSkip = (op: JOp, skip: SkipFact): boolean => match(op, {
  dispute_start: ({ start }) =>
    skip.op === 0 && same(start.counterentity, skip.counterentity) && start.nonce === skip.nonce,
  dispute_counter: ({ counter }) =>
    skip.op === 1 && same(counter.counterentity, skip.counterentity) && counter.counterNonce === skip.nonce,
  dispute_finalize: ({ finalization }) =>
    skip.op === 2 && same(finalization.counterentity, skip.counterentity) && finalization.finalNonce === skip.nonce,
  deposit: () => false, reserve_to_reserve: () => false, reserve_to_collateral: () => false,
  collateral_to_reserve: () => false, settle: () => false, reserve_to_external: () => false, reveal_secret: () => false,
});

const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

const skippedIn = (batch: SealedBatch, skips: readonly SkipFact[]): readonly Skipped[] =>
  skips.flatMap((skip) => batch.ops.filter((op) => isSkip(op, skip)).map((op) => ({ op, reason: skip.reason })));

/** The newest landed requests, the one landed again replacing its older copy. */
const remembered = (j: JBatch, named: readonly JOp[]): readonly JOp[] =>
  [...j.landed.filter((old) => !sameKey(old, new Set(named.map((op) => orElse(requestKey(op), ""))))), ...named]
    .slice(-LANDED_MEMORY);

const landed = (j: JBatch, a: Extract<JAnswer, { _tag: "landed" }>): Observed => {
  const synced = { ...j, chainNonce: larger(j.chainNonce, a.nonce) };
  const batch = signed(j).find((b) => same(b.digest, a.batchHash));
  if (batch === undefined) return unchanged(synced);
  const done = new Set(batch.ops.map((op) => orElse(requestKey(op), "")).filter((key) => key !== ""));
  const rest = without(synced, batch);
  const named = batch.ops.filter((op) => sameKey(op, done));
  return {
    jbatch: { ...rest, draft: rest.draft.filter((op) => !sameKey(op, done)), landed: remembered(rest, named) },
    returned: [], skipped: skippedIn(batch, a.skipped),
  };
};

/** Back to the front of the draft, oldest first, unless the request is on its way already or the draft is full. */
const requeue = (j: JBatch, ops: readonly JOp[]): Observed => {
  const keys = submitted(j);
  const outcome = ops.reduce<{ front: readonly JOp[]; returned: readonly Returned[] }>((acc, op) => {
    if (sameKey(op, keys)) return acc;
    const fault = fitFault(j.entity, [...acc.front, op, ...j.draft]);
    if (fault._tag === "none") return { front: [...acc.front, op], returned: acc.returned };
    const refused: Returned = { op, because: { _tag: "draft_full", fault: fault.value } };
    return { front: acc.front, returned: [...acc.returned, refused] };
  }, { front: [], returned: [] });
  return { jbatch: { ...j, draft: [...outcome.front, ...j.draft] }, returned: outcome.returned, skipped: [] };
};

const failed = (j: JBatch, a: Extract<JAnswer, { _tag: "failed" }>): Observed => {
  const synced = { ...j, chainNonce: larger(j.chainNonce, a.nonce) };
  const batch = signed(j).find((b) => b.nonce === a.nonce);
  if (batch === undefined) return unchanged(synced);
  const cosigned = batch.ops.filter(isCosigned);
  const back = requeue(without(synced, batch), batch.ops.filter((op) => !isCosigned(op)));
  const because = { _tag: "batch_failed", reason: a.reason } as const;
  return { ...back, returned: [...cosigned.map((op) => ({ op, because })), ...back.returned] };
};

export const observe = (j: JBatch, answer: JAnswer): Observed => match(answer, {
  landed: (a) => landed(j, a),
  failed: (a) => failed(j, a),
  starved: () => unchanged(j),
});

/**
 * Give up waiting for the sent batch. It may land after all, so it is kept and its nonce is never reused; the ops that
 * are safe to send twice are drafted again so they can ride a batch that does get through.
 */
export const abort = (j: JBatch): Observed => {
  if (j.phase._tag !== "inflight") return unchanged(j);
  const batch = j.phase.sent;
  const back = requeue({ ...j, phase: { _tag: "idle" } }, batch.ops.filter(isIdempotent));
  return { ...back, jbatch: { ...back.jbatch, abandoned: [...j.abandoned, batch] } };
};

/** The signed batch the chain accepts next, if the Entity holds it: resend it (sent) or push it (abandoned). */
export const landable = (j: JBatch): Option<SealedBatch> => {
  const next = signed(j).find((b) => b.nonce === j.chainNonce + 1n);
  return next === undefined ? none : some(next);
};
