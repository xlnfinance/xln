// The Depository's limits on one batch (DepositoryBounds.sol `assertBatch`, Depository `MAX_ENCODED_BATCH_BYTES`),
// checked when an op is queued so that a draft always fits a batch (R-J3): a full draft refuses the op with a notice,
// and the refusal is a value, never a throw. The numbers are the contract's; DepositoryBounds is the source.
import { err, ok, type Result } from "../../kernel/core/result.ts";
import type { Tagged } from "../../kernel/core/tagged.ts";
import type { JOp, OpKind } from "./ops.ts";

/** At most this many ops of a kind in one batch. */
export const KIND_LIMIT: Readonly<Record<OpKind, number>> = {
  reserve_to_reserve: 64, reserve_to_collateral: 64, collateral_to_reserve: 64, settle: 32, dispute_start: 8,
  dispute_counter: 8, dispute_finalize: 1, deposit: 64, reserve_to_external: 64, reveal_secret: 32,
};

export const TOTAL_LIMIT = 50;
export const PAIRS_PER_FUNDING = 64;
export const PAIRS_TOTAL = 250;

/** `Depository.MAX_ENCODED_BATCH_BYTES`: a larger encoded batch is E10. */
export const MAX_ENCODED_BYTES = 256 * 1024;

export type LimitFault =
  | Tagged<"too_many_ops", { total: number; max: number }>
  | Tagged<"too_many_of_kind", { kind: OpKind; count: number; max: number }>
  | Tagged<"too_many_pairs", { pairs: number; max: number }>;

const countOf = (ops: readonly JOp[], kind: OpKind): number => ops.filter((op) => op._tag === kind).length;

const pairsOf = (op: JOp): number => (op._tag === "reserve_to_collateral" ? op.funding.pairs.length : 0);

const kindFault = (ops: readonly JOp[]): LimitFault | undefined => {
  const over = (Object.keys(KIND_LIMIT) as OpKind[]).find((kind) => countOf(ops, kind) > KIND_LIMIT[kind]);
  if (over === undefined) return undefined;
  return { _tag: "too_many_of_kind", kind: over, count: countOf(ops, over), max: KIND_LIMIT[over] };
};

const pairFault = (ops: readonly JOp[]): LimitFault | undefined => {
  const widest = Math.max(0, ...ops.map(pairsOf));
  const total = ops.reduce((sum, op) => sum + pairsOf(op), 0);
  if (widest > PAIRS_PER_FUNDING) return { _tag: "too_many_pairs", pairs: widest, max: PAIRS_PER_FUNDING };
  return total > PAIRS_TOTAL ? { _tag: "too_many_pairs", pairs: total, max: PAIRS_TOTAL } : undefined;
};

/** The ops themselves when one batch may carry them all, else the first limit they pass. */
export const withinLimits = (ops: readonly JOp[]): Result<readonly JOp[], LimitFault> => {
  const fault: LimitFault | undefined = ops.length > TOTAL_LIMIT
    ? { _tag: "too_many_ops", total: ops.length, max: TOTAL_LIMIT }
    : kindFault(ops) ?? pairFault(ops);
  return fault === undefined ? ok(ops) : err(fault);
};
