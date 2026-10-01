// What an Entity asks its Depository for: one operation per entry of a batch list (Types.sol `Batch`).
//
// An operation is queued by an Account or by the Runtime and waits in a draft until a batch carries it. Three facts
// about its kind decide how it may travel: whether the contract reverts the whole batch when it fails (hard) or fails
// it softly and keeps the nonce spent (R-SPLIT, J5), whether a counterparty signed it (R-COSIGN), and which Account it
// is about.
import type {
  CollateralToReserve, CounterDisputeProof, ExternalTokenToReserve, FinalDisputeProof, InitialDisputeProof,
  ReserveToCollateral, ReserveToReserve, SecretReveal, Settlement,
} from "../../chain/batch/batch.ts";
import { none, some, type Option } from "../../kernel/core/option.ts";
import { match, type Tagged } from "../../kernel/core/tagged.ts";

export type JOp =
  | Tagged<"deposit", { leg: ExternalTokenToReserve }>
  | Tagged<"reserve_to_reserve", { transfer: ReserveToReserve }>
  | Tagged<"reserve_to_collateral", { funding: ReserveToCollateral }>
  | Tagged<"collateral_to_reserve", { withdrawal: CollateralToReserve }>
  | Tagged<"settle", { settlement: Settlement }>
  | Tagged<"reserve_to_external", { withdrawal: ReserveToReserve }>
  | Tagged<"dispute_start", { start: InitialDisputeProof }>
  | Tagged<"dispute_counter", { counter: CounterDisputeProof }>
  | Tagged<"dispute_finalize", { finalization: FinalDisputeProof }>
  | Tagged<"reveal_secret", { reveal: SecretReveal }>;

export type OpKind = JOp["_tag"];

/**
 * Hard ops are the ones `Depository._revertsWhole` names (a dispute, a reveal, a deposit leg): a batch that carries one
 * and fails reverts whole and takes no nonce. A batch of soft ops that fails applies nothing and takes its nonce.
 */
export type OpClass = "hard" | "soft";

const CLASS: Readonly<Record<OpKind, OpClass>> = {
  deposit: "hard", dispute_start: "hard", dispute_counter: "hard", dispute_finalize: "hard", reveal_secret: "hard",
  reserve_to_reserve: "soft", reserve_to_collateral: "soft", collateral_to_reserve: "soft", settle: "soft",
  reserve_to_external: "soft",
};

export const classOf = (op: JOp): OpClass => CLASS[op._tag];

/** The ops a counterparty signed over an Account's epoch: a change on the counterparty's side can fail them. */
export const isCosigned = (op: JOp): boolean => op._tag === "settle" || op._tag === "collateral_to_reserve";

export const isDispute = (op: JOp): boolean =>
  op._tag === "dispute_start" || op._tag === "dispute_counter" || op._tag === "dispute_finalize";

/**
 * Ops that are safe to send twice, so an abort puts them back in the draft: a second dispute step is skipped by the
 * chain with a DisputeOpSkipped (J2), and `DeltaTransformer.revealSecret` returns when the hash is already revealed. A
 * deposit, a payment and a settlement are not: if the batch given up on still lands, the copy would apply again.
 */
export const isIdempotent = (op: JOp): boolean => isDispute(op) || op._tag === "reveal_secret";

const asId = (id: string): string => id.toLowerCase();

/** The counterparty of `self` in a settlement: the side that is not `self`. */
const otherSide = (self: string, s: Settlement): string =>
  (asId(s.leftEntity) === asId(self) ? s.rightEntity : s.leftEntity);

/**
 * The Accounts an op is about, as the counterparty each is with. A reserve transfer touches no Account; a funding
 * names one per pair.
 */
export const accountsOf = (self: string, op: JOp): readonly string[] => match(op, {
  deposit: () => [],
  reserve_to_reserve: () => [],
  reserve_to_external: () => [],
  reserve_to_collateral: ({ funding }) => funding.pairs.map((p) => p.entity),
  collateral_to_reserve: ({ withdrawal }) => [withdrawal.counterparty],
  settle: ({ settlement }) => [otherSide(self, settlement)],
  dispute_start: ({ start }) => [start.counterentity],
  dispute_counter: ({ counter }) => [counter.counterentity],
  dispute_finalize: ({ finalization }) => [finalization.counterentity],
  reveal_secret: () => [],
});

const joined = (parts: readonly (string | bigint | boolean)[]): string =>
  parts.map((p) => String(p).toLowerCase()).join("/");

/**
 * What makes two queued ops the same request. Signed, idempotent ops (a settlement, a withdrawal, a dispute step, a
 * reveal) are named by what they act on; a money movement (a deposit, a reserve transfer, a funding) is a request
 * of its own every time, so two of the same amount are two ops and never one.
 *
 * A dispute step is named by every field the contract ranks or acts on, who authored it and which kind of step it is:
 * at an equal nonce a Left-authored counter outranks a Right-authored one (R-A1) and a cooperative finalize closes at
 * once where a unilateral one waits, so none of those pairs may be merged into one.
 */
export const requestKey = (op: JOp): Option<string> => match(op, {
  deposit: () => none,
  reserve_to_reserve: () => none,
  reserve_to_external: () => none,
  reserve_to_collateral: () => none,
  collateral_to_reserve: ({ withdrawal: w }) => some(joined(["c2r", w.counterparty, w.tokenId, w.nonce])),
  settle: ({ settlement: s }) => some(joined(["settle", s.leftEntity, s.rightEntity, s.nonce])),
  dispute_start: ({ start: s }) =>
    some(joined(["start", s.counterentity, s.nonce, s.ondeltaEpoch, s.proposerIsLeft, s.proofbodyHash])),
  dispute_counter: ({ counter: c }) => some(joined([
    "counter", c.counterentity, c.initialNonce, c.counterNonce, c.proposerIsLeft, c.initialProofbodyHash,
  ])),
  dispute_finalize: ({ finalization: f }) => some(joined([
    "finalize", f.counterentity, f.initialNonce, f.finalNonce, f.proposerIsLeft, f.startedByLeft, f.cooperative,
    f.initialProofbodyHash,
  ])),
  reveal_secret: ({ reveal }) => some(joined(["reveal", reveal.transformer, reveal.secret])),
});
