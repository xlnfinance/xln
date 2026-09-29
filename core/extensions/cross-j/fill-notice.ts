import type { EntityTx } from '../../types/entity-tx';
import type { CrossJurisdictionFillInstruction } from './orderbook';
import type { CrossJurisdictionSwapRoute } from '../../types/cross-jurisdiction';

export type CrossJurisdictionFillNoticeTx = Extract<EntityTx, { type: 'crossJurisdictionFillNotice' }>;
export type CrossJurisdictionFillProgressData = CrossJurisdictionFillNoticeTx['data'];

/** Hub-internal ratio and exact book execution; only the reveal authorizes a close. */
export const buildCrossJurisdictionFillProgressData = (
  instruction: CrossJurisdictionFillInstruction,
): CrossJurisdictionFillProgressData => ({
  orderId: instruction.offerId,
  ...(instruction.route.routeHash ? { routeHash: instruction.route.routeHash } : {}),
  fillSeq: instruction.fillSeq,
  cumulativeFillRatio: instruction.fillRatio,
  cumulativeExecutionSourceAmount: (instruction.route.executionSourceAmount ?? 0n) + instruction.executionSourceAmount,
  cumulativeExecutionTargetAmount: (instruction.route.executionTargetAmount ?? 0n) + instruction.executionTargetAmount,
  cancelRemainder: instruction.cancelRemainder,
});

export const buildCrossJurisdictionFillNoticeTx = (
  instruction: CrossJurisdictionFillInstruction,
): CrossJurisdictionFillNoticeTx => ({
  type: 'crossJurisdictionFillNotice',
  data: buildCrossJurisdictionFillProgressData(instruction),
});

export const applyCrossJurisdictionExecutionProgress = (
  route: CrossJurisdictionSwapRoute,
  data: CrossJurisdictionFillProgressData,
): void => {
  const source = data.cumulativeExecutionSourceAmount;
  const target = data.cumulativeExecutionTargetAmount;
  if (
    source < (route.executionSourceAmount ?? 0n) ||
    target < (route.executionTargetAmount ?? 0n) ||
    source > route.source.amount ||
    target > route.target.amount
  ) throw new Error(`CROSS_J_EXECUTION_PROGRESS_INVALID:${route.orderId}`);
  route.executionSourceAmount = source;
  route.executionTargetAmount = target;
};
