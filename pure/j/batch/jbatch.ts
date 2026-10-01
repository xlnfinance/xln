// The Entity's side of the Depository batch: a draft of ops waiting for a batch, and at most one batch in flight.
//
//   queue  an Account or the Runtime asks for an op. It joins the draft, or it is skipped when the same request is
//          already on its way (R-SAME-FRAME-SETTLE-PENDING), or it is refused: the draft is full or a group would be
//          too large for one batch (R-J3), or a request of the same name with other content is already on its way.
//   seal   idle with something to send: pick the first group that is funded, give it the next fresh nonce, and send it.
//
// The chain's answers and the retry, abort and push of a batch that is not answering are in answer.ts; what sealing
// asks of the Host before it signs (R-SIMULATE) is in ../gas/simulate.ts.
import type { Deployment } from "../../chain/proof/deployment.ts";
import { match, type Tagged } from "../../kernel/core/tagged.ts";
import { orElse } from "../../kernel/core/option.ts";
import { stepFor, type Gas, type HoldReason, type Simulation } from "../gas/simulate.ts";
import { fundedFirst, type Treasury } from "../plan/funded.ts";
import { groupsOf } from "../plan/group.ts";
import { fitFault, fitPrefix, type FitFault } from "../plan/fit.ts";
import { assemble } from "../op/assemble.ts";
import { requestKey, type JOp } from "../op/ops.ts";
import { encodeBatch } from "../../chain/batch/batch.ts";
import { sealBatch, type SealedBatch, type SealFault } from "./sealed.ts";

export type Phase = Tagged<"idle"> | Tagged<"inflight", { sent: SealedBatch }>;

export type JBatch = Readonly<{
  entity: string;
  draft: readonly JOp[];
  phase: Phase;
  /** F1: the highest batch nonce this Entity ever signed. A new batch is signed above it, whatever the chain holds. */
  signedMax: bigint;
  /** The Depository's entity nonce as the Entity last saw it: the next batch the chain accepts is at this plus one. */
  chainNonce: bigint;
  /** Batches given up on. They stay signed and may still land (F1), so they are never signed again. */
  abandoned: readonly SealedBatch[];
}>;

/** An Entity with nothing queued, whose Depository entity nonce is `chainNonce`. */
export const openJBatch = (entity: string, chainNonce: bigint): JBatch =>
  ({ entity, draft: [], phase: { _tag: "idle" }, signedMax: chainNonce, chainNonce, abandoned: [] });

const inFlight = (j: JBatch): readonly JOp[] =>
  [...(j.phase._tag === "inflight" ? j.phase.sent.ops : []), ...j.abandoned.flatMap((b) => b.ops)];

/** The named requests the Entity already has on their way: in the draft, in the batch it sent or one given up on. */
export const submitted = (j: JBatch): ReadonlyMap<string, JOp> =>
  new Map([...j.draft, ...inFlight(j)].flatMap((op): [string, JOp][] => {
    const key = orElse(requestKey(op), "");
    return key === "" ? [] : [[key, op]];
  }));

/** The same request is the same bytes for the Depository: nothing the contract reads tells the two apart. */
const sameOp = (a: JOp, b: JOp): boolean => {
  const [x, y] = [a, b].map((op) => encodeBatch(assemble(0n, [op])));
  return x !== undefined && y !== undefined && x.ok && y.ok && x.value === y.value;
};

export type QueueFault = FitFault | Tagged<"conflicting_request", { key: string }>;

export type QueueOutcome =
  | Tagged<"queued", { jbatch: JBatch }>
  | Tagged<"skipped", { jbatch: JBatch; reason: "already_submitted" }>
  | Tagged<"refused", { fault: QueueFault }>;

/**
 * R-SAME-FRAME-SETTLE-PENDING, the nonce half: a request already on its way is a no-op skip, not a refusal and not an
 * eviction, so the command that carried it still advances its nonce and both sides' frames stay monotonic. Only a
 * refusal leaves the nonce where it was.
 */
export const advancesCommandNonce = (outcome: QueueOutcome): boolean => outcome._tag !== "refused";

/**
 * A request with a name is skipped only when it is the same op as the one on its way. The same name with other content
 * (a settlement at the same Account nonce with other diffs) is a different request, never a duplicate: it is refused
 * as conflicting so the Account layer sees it, instead of being dropped while its command advances.
 */
const duplicate = (j: JBatch, op: JOp): QueueOutcome | undefined => {
  const key = orElse(requestKey(op), "");
  const known = key === "" ? undefined : submitted(j).get(key);
  if (known === undefined) return undefined;
  return sameOp(known, op)
    ? { _tag: "skipped", jbatch: j, reason: "already_submitted" }
    : { _tag: "refused", fault: { _tag: "conflicting_request", key } };
};

export const queue = (j: JBatch, op: JOp): QueueOutcome => {
  const seen = duplicate(j, op);
  if (seen !== undefined) return seen;
  const draft = [...j.draft, op];
  const fault = fitFault(j.entity, draft);
  return fault._tag === "some" ? { _tag: "refused", fault: fault.value } : { _tag: "queued", jbatch: { ...j, draft } };
};

/**
 * What sealing needs from the world: the deployment signed for, what the chain holds for the Entity, the chain's gas
 * limits, and the simulations the Host has answered so far (at the head it just read: stale ones are the Host's to
 * drop).
 */
export type SealContext = Readonly<{
  deployment: Deployment; treasury: Treasury; gas: Gas; answers: readonly Simulation[];
}>;

export type SealOutcome =
  | Tagged<"nothing_to_send">
  | Tagged<"in_flight", { sent: SealedBatch }>
  | Tagged<"simulate", { candidate: SealedBatch }>
  | Tagged<"held", { why: readonly HoldReason[] }>
  | Tagged<"sealed", { jbatch: JBatch; batch: SealedBatch }>;

/** The funded front of each group that has one, in the order the planner prefers them. */
const sendable = (j: JBatch, treasury: Treasury): readonly (readonly JOp[])[] =>
  groupsOf(j.entity, j.draft).map((group) => fitPrefix(fundedFirst(j.entity, treasury, group).funded))
    .filter((funded) => funded.length > 0);

/** The draft without the ops that were sent, one match for each: the same object queued twice is two ops. */
const withoutSent = (draft: readonly JOp[], ops: readonly JOp[]): readonly JOp[] =>
  ops.reduce((rest, op) => {
    const at = rest.indexOf(op);
    return at < 0 ? rest : [...rest.slice(0, at), ...rest.slice(at + 1)];
  }, draft);

const sent = (j: JBatch, batch: SealedBatch): JBatch => ({
  ...j, draft: withoutSent(j.draft, batch.ops), phase: { _tag: "inflight", sent: batch }, signedMax: batch.nonce,
});

type Groups = readonly (readonly JOp[])[];

const firstOpen = (j: JBatch, ctx: SealContext, groups: Groups, held: readonly HoldReason[]): SealOutcome => {
  const [ops, ...rest] = groups;
  if (ops === undefined) return { _tag: "held", why: held };
  const base = { deployment: ctx.deployment, entity: j.entity, nonce: j.signedMax + 1n };
  return match(stepFor(base, ctx.gas, ctx.answers, ops), {
    hold: ({ why }) => firstOpen(j, ctx, rest, [...held, why]),
    simulate: ({ candidate }) => ({ _tag: "simulate", candidate }),
    sign: ({ candidate }) => ({ _tag: "sealed", jbatch: sent(j, candidate), batch: candidate }),
  });
};

/**
 * Idle with something to send: the first group that is funded and whose simulation does not revert is split to what
 * the chain's limits carry, simulated at its final budget, and only then signed (R-SIMULATE). Until the Host has
 * answered the simulation it asks for, the outcome is that request and nothing is signed. A group that would revert is
 * held and the next one is tried, so a finalize waiting for its gate does not stop a payment behind it.
 */
export const seal = (j: JBatch, ctx: SealContext): SealOutcome => {
  if (j.phase._tag === "inflight") return { _tag: "in_flight", sent: j.phase.sent };
  const groups = sendable(j, ctx.treasury);
  return groups.length === 0 ? { _tag: "nothing_to_send" } : firstOpen(j, ctx, groups, []);
};
