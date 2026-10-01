// Which ops of a draft may travel together: the groups a batch is made from, most urgent first.
//
// R-SPLIT: a hard op (a dispute, a reveal, a deposit leg) never shares a batch with a soft one, because a mixed batch
// that fails reverts without taking its nonce and stalls every batch above it. J6: a deposit leg travels alone. a
// finalize travels alone, because one whose HTLC deadline is open reverts the whole batch. R-COSIGN: a batch with a
// co-signed op carries ops of that one Account only, because a counterparty's move can fail it and a failure burns the
// nonce.
import { classOf, accountsOf, isCosigned, isDispute, type JOp } from "../op/ops.ts";

export type Group = readonly JOp[];

const kindIs = (kind: JOp["_tag"]) => (op: JOp): boolean => op._tag === kind;

/** Reveals, starts and counters: urgent, and safe to carry together (a start that follows a reveal reads it). */
const urgent = (draft: readonly JOp[]): Group =>
  draft.filter((op) => isDispute(op) && op._tag !== "dispute_finalize" || op._tag === "reveal_secret");

const alone = (draft: readonly JOp[], kind: JOp["_tag"]): readonly Group[] =>
  draft.filter(kindIs(kind)).map((op) => [op]);

const softOps = (draft: readonly JOp[]): Group => draft.filter((op) => classOf(op) === "soft");

/** The ops of one Account only: every Account an op names is that one. An op that touches none is not about it. */
const ofAccount = (self: string, soft: Group, counterparty: string): Group =>
  soft.filter((op) => {
    const accounts = accountsOf(self, op);
    return accounts.length > 0 && accounts.every((a) => a.toLowerCase() === counterparty.toLowerCase());
  });

/** One group per co-signed op's Account, in the order the draft first names them. */
const cosignedGroups = (self: string, soft: Group): readonly Group[] => {
  const accounts = soft.filter(isCosigned).flatMap((op) => accountsOf(self, op).slice(0, 1));
  const firstSeen = accounts.filter((a, i) => accounts.findIndex((b) => b.toLowerCase() === a.toLowerCase()) === i);
  return firstSeen.map((account) => ofAccount(self, soft, account));
};

/**
 * The groups a draft offers, most urgent first: reveals with starts and counters, then each finalize alone, then each
 * deposit leg alone, then one group per co-signed Account, then the soft ops no counterparty signed, together. A
 * caller seals the first group that is funded and simulates well; the rest wait in the draft.
 */
export const groupsOf = (self: string, draft: readonly JOp[]): readonly Group[] => {
  const cosigned = cosignedGroups(self, softOps(draft));
  const claimed = new Set(cosigned.flat());
  return [
    urgent(draft),
    ...alone(draft, "dispute_finalize"),
    ...alone(draft, "deposit"),
    ...cosigned,
    softOps(draft).filter((op) => !claimed.has(op)),
  ].filter((group) => group.length > 0);
};
