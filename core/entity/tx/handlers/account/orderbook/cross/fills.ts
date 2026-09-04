import { haltRuntimeFailure } from "../../../../../../protocol/errors/failure-taxonomy";

import { createStructuredLogger, shortOrder } from '../../../../../../support/logger';
import { compareCanonicalText } from '../../../../../../orderbook/swap-execution';
import {
  buildCrossJurisdictionFillInstruction,
  type CrossJurisdictionFillInstruction,
} from '../../../../../../extensions/cross-j/orderbook';
import { crossJurisdictionAssetKey } from '../../../../../../extensions/cross-j/market';
import {
  buildCrossMarketOfferFromBookOrder,
  parseNamespacedOrderId,
} from '../helpers';
import { removeCrossBookOrderAfterFill } from './book';
import type { CrossOrderbookPass } from './types';

const orderbookCrossLog = createStructuredLogger('orderbook.cross');

const assertPlannedCrossFillConservation = (
  plans: readonly CrossJurisdictionFillInstruction[],
): void => {
  const netByAsset = new Map<string, bigint>();
  for (const instruction of plans) {
    const sourceKey = crossJurisdictionAssetKey(
      instruction.route.source.jurisdiction,
      instruction.route.source.tokenId,
    );
    const targetKey = crossJurisdictionAssetKey(
      instruction.route.target.jurisdiction,
      instruction.route.target.tokenId,
    );
    netByAsset.set(
      sourceKey,
      (netByAsset.get(sourceKey) ?? 0n) - instruction.executionSourceAmount,
    );
    netByAsset.set(
      targetKey,
      (netByAsset.get(targetKey) ?? 0n) + instruction.executionTargetAmount,
    );
  }
  const mismatches = [...netByAsset.entries()]
    .filter(([, net]) => net !== 0n)
    .sort(([left], [right]) => compareCanonicalText(left, right));
  if (mismatches.length > 0) {
    throw haltRuntimeFailure("CROSS_J_TRADE_CONSERVATION_FAILED", `CROSS_J_TRADE_CONSERVATION_FAILED:` +
      mismatches.map(([asset, net]) => `${asset}=${net}`).join(','));
  }
};

const planCrossFills = (pass: CrossOrderbookPass): CrossJurisdictionFillInstruction[] => {
  const planned: CrossJurisdictionFillInstruction[] = [];
  const orderIds = [...pass.aggregatedFills.keys()].sort(compareCanonicalText);
  for (const orderId of orderIds) {
    const fill = pass.aggregatedFills.get(orderId);
    if (!fill) continue;
    const meta =
      pass.crossLiveOfferMeta.get(orderId) ??
      buildCrossMarketOfferFromBookOrder(pass.hubState, orderId);
    if (!meta) {
      throw haltRuntimeFailure("ORDERBOOK_CROSS_J_FILL_META_MISSING", `ORDERBOOK_CROSS_J_FILL_META_MISSING: order=${orderId}`);
    }
    const { accountId, offerId } = parseNamespacedOrderId(
      orderId,
      'ORDERBOOK_CROSS_J_MALFORMED_FILL_ORDER',
    );
    const instruction = buildCrossJurisdictionFillInstruction(
      accountId,
      offerId,
      orderId,
      meta,
      fill,
    );
    if (!instruction) {
      throw haltRuntimeFailure("ORDERBOOK_CROSS_J_FILL_INSTRUCTION_MISSING", `ORDERBOOK_CROSS_J_FILL_INSTRUCTION_MISSING: order=${orderId} ` +
        `account=${accountId} offer=${offerId} filledLots=${fill.filledLots}`);
    }
    planned.push(instruction);
  }
  return planned;
};

const commitCrossFill = (
  pass: CrossOrderbookPass,
  instruction: CrossJurisdictionFillInstruction,
): void => {
  const { orderId } = instruction;
  const meta =
    pass.crossLiveOfferMeta.get(orderId) ??
    buildCrossMarketOfferFromBookOrder(pass.hubState, orderId);
  if (!meta) {
    throw haltRuntimeFailure("ORDERBOOK_CROSS_J_FILL_META_MISSING", `ORDERBOOK_CROSS_J_FILL_META_MISSING: order=${orderId}`);
  }
  orderbookCrossLog.debug('fill', {
    account: shortOrder(instruction.accountId, 12),
    offer: shortOrder(instruction.offerId, 12),
    cancel: instruction.cancelRemainder,
    ratio: instruction.fillRatio,
  });
  if (instruction.cancelRemainder) {
    removeCrossBookOrderAfterFill(
      pass,
      meta.pairId,
      orderId,
      'cross-fill-terminal',
    );
  }
  pass.crossJurisdictionFills.push(instruction);
};

/**
 * Fill progress is Hub-internal. The matcher records exact progress per order;
 * the Entity frame applies it to the admitted route (book owner) and to the
 * source Hub route mirror, and the ladder reveal at close settles both
 * Account legs. Nothing here enters a bilateral Account frame.
 */
export const finalizeCrossOrderbookFills = (
  pass: CrossOrderbookPass,
): void => {
  const planned = planCrossFills(pass);
  assertPlannedCrossFillConservation(planned);
  for (const instruction of planned) commitCrossFill(pass, instruction);
};
