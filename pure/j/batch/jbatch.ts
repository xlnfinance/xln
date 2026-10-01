// The Entity's side of the Depository batch: a draft of ops waiting for a batch, and at most one batch in flight.
//
//   queue  an Account or the Runtime asks for an op. It joins the draft, or it is skipped when the same request is
//          already on its way (R-SAME-FRAME-SETTLE-PENDING), or it is refused when the draft is full (R-J3).
//   seal   idle with something to send: pick the first group that is funded, give it the next fresh nonce, and send it.
//
// The chain's answers (landed, failed, skipped) and the retry, abort and push of a batch that is not answering are the
// other half of the page and are not in this file yet.
import type { Deployment } from "../../chain/proof/deployment.ts";
import { match, type Tagged } from "../../kernel/core/tagged.ts";
import { orElse } from "../../kernel/core/option.ts";
import { fundedFirst, type Treasury } from "../plan/funded.ts";
import { groupsOf } from "../plan/group.ts";
import { withinLimits, type LimitFault } from "../op/limits.ts";
import { requestKey, type JOp } from "../op/ops.ts";
import { sealBatch, type SealedBatch, type SealFault } from "./sealed.ts";

export type Phase = Tagged<"idle"> | Tagged<"inflight", { sent: SealedBatch }>;

export type JBatch = Readonly<{
  entity: string;
  draft: readonly JOp[];
  phase: Phase;
  /** F1: the highest batch nonce this Entity ever signed. A new batch is signed above it, whatever the chain holds. */
  signedMax: bigint;
}>;

/** An Entity with nothing queued, whose Depository entity nonce is `chainNonce`. */
export const openJBatch = (entity: string, chainNonce: bigint): JBatch =>
  ({ entity, draft: [], phase: { _tag: "idle" }, signedMax: chainNonce });

const inFlight = (j: JBatch): readonly JOp[] => match(j.phase, { idle: () => [], inflight: ({ sent }) => sent.ops });

/** The requests the Entity already has on their way: in the draft or in the batch it sent. */
const submitted = (j: JBatch): ReadonlySet<string> =>
  new Set([...j.draft, ...inFlight(j)].map((op) => orElse(requestKey(op), "")).filter((key) => key !== ""));

export type QueueOutcome =
  | Tagged<"queued", { jbatch: JBatch }>
  | Tagged<"skipped", { jbatch: JBatch; reason: "already_submitted" }>
  | Tagged<"refused", { fault: LimitFault }>;

/**
 * R-SAME-FRAME-SETTLE-PENDING, the nonce half: a request already on its way is a no-op skip, not a refusal and not an
 * eviction, so the command that carried it still advances its nonce and both sides' frames stay monotonic. Only a
 * refusal leaves the nonce where it was.
 */
export const advancesCommandNonce = (outcome: QueueOutcome): boolean => outcome._tag !== "refused";

export const queue = (j: JBatch, op: JOp): QueueOutcome => {
  const key = orElse(requestKey(op), "");
  if (key !== "" && submitted(j).has(key)) return { _tag: "skipped", jbatch: j, reason: "already_submitted" };
  const checked = withinLimits([...j.draft, op]);
  return checked.ok
    ? { _tag: "queued", jbatch: { ...j, draft: checked.value } }
    : { _tag: "refused", fault: checked.error };
};

/** What sealing needs from the world: the deployment signed for, what the chain holds for the Entity, the budget. */
export type SealContext = Readonly<{ deployment: Deployment; treasury: Treasury; gasBudget: bigint }>;

export type SealOutcome =
  | Tagged<"nothing_to_send">
  | Tagged<"in_flight", { sent: SealedBatch }>
  | Tagged<"sealed", { jbatch: JBatch; batch: SealedBatch }>
  | Tagged<"fault", { fault: SealFault }>;

/** The ops of the first group that has a funded part: that part goes, the rest wait in the draft. */
const firstSendable = (j: JBatch, treasury: Treasury): readonly JOp[] =>
  groupsOf(j.entity, j.draft)
    .map((group) => fundedFirst(j.entity, treasury, group).funded)
    .find((funded) => funded.length > 0) ?? [];

const sent = (j: JBatch, ops: readonly JOp[], batch: SealedBatch): JBatch => ({
  ...j, draft: j.draft.filter((op) => !ops.includes(op)), phase: { _tag: "inflight", sent: batch },
  signedMax: batch.nonce,
});

export const seal = (j: JBatch, ctx: SealContext): SealOutcome => {
  if (j.phase._tag === "inflight") return { _tag: "in_flight", sent: j.phase.sent };
  const ops = firstSendable(j, ctx.treasury);
  if (ops.length === 0) return { _tag: "nothing_to_send" };
  const sealing = { deployment: ctx.deployment, entity: j.entity, nonce: j.signedMax + 1n, gasBudget: ctx.gasBudget };
  const batch = sealBatch(sealing, ops);
  return batch.ok
    ? { _tag: "sealed", jbatch: sent(j, ops, batch.value), batch: batch.value }
    : { _tag: "fault", fault: batch.error };
};
