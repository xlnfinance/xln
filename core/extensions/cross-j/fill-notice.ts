import type { EntityTx } from '../../types/entity-tx';
import type { CrossJurisdictionFillInstruction } from './orderbook';

export type CrossJurisdictionFillNoticeTx = Extract<EntityTx, { type: 'crossJurisdictionFillNotice' }>;
export type CrossJurisdictionFillProgressData = CrossJurisdictionFillNoticeTx['data'];

/**
 * Hub-internal fill progress: one uint16 ratio per order. The book owner
 * matched (or cancelled) the order; the source Hub needs the same ratio to
 * request the clear and to build the ladder reveal. It never enters bilateral
 * Account consensus: the reveal is the only settlement authority for both legs.
 */
export const buildCrossJurisdictionFillProgressData = (
  instruction: CrossJurisdictionFillInstruction,
): CrossJurisdictionFillProgressData => ({
  orderId: instruction.offerId,
  ...(instruction.route.routeHash ? { routeHash: instruction.route.routeHash } : {}),
  fillSeq: instruction.fillSeq,
  cumulativeFillRatio: instruction.fillRatio,
  cancelRemainder: instruction.cancelRemainder,
});

export const buildCrossJurisdictionFillNoticeTx = (
  instruction: CrossJurisdictionFillInstruction,
): CrossJurisdictionFillNoticeTx => ({
  type: 'crossJurisdictionFillNotice',
  data: buildCrossJurisdictionFillProgressData(instruction),
});
