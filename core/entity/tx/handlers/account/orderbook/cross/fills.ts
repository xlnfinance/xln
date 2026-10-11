import { haltRuntimeFailure } from "../../../../../../protocol/errors/failure-taxonomy";

import { createStructuredLogger, shortOrder } from '../../../../../../support/logger';
import { compareCanonicalText } from '../../../../../../swapbook/swap-execution';
import {
  buildCrossJurisdictionCancelInstruction,
  buildCrossJurisdictionFillInstruction,
  crossJurisdictionExecutionAmounts,
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

const assertCrossFillConservation = (netByAsset: ReadonlyMap<string, bigint>): void => {
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
  // Conservation is over every executed amount, including fills the Hub
  // absorbs below one uint16 step (Rust nets the same set).
  const netByAsset = new Map<string, bigint>();
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
    const execution = crossJurisdictionExecutionAmounts(meta, fill);
    if (execution) {
      const sourceKey = crossJurisdictionAssetKey(meta.route.source.jurisdiction, meta.route.source.tokenId);
      const targetKey = crossJurisdictionAssetKey(meta.route.target.jurisdiction, meta.route.target.tokenId);
      netByAsset.set(sourceKey, (netByAsset.get(sourceKey) ?? 0n) - execution.executionSourceAmount);
      netByAsset.set(targetKey, (netByAsset.get(targetKey) ?? 0n) + execution.executionTargetAmount);
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
    if (!instruction && fill.cancelRemainder) {
      // The taker's remainder is cancelled even when its own fill is absorbed.
      planned.push(buildCrossJurisdictionCancelInstruction(accountId, offerId, orderId, meta.route));
      continue;
    }
    if (!instruction) {
      // A fill below one uint16 step does not move the ratio; the Hub absorbs
      // it and the next fill carries the cumulative progress.
      orderbookCrossLog.debug('fill.sub_step_absorbed', {
        account: shortOrder(accountId, 12),
        offer: shortOrder(offerId, 12),
        filledLots: String(fill.filledLots),
      });
      continue;
    }
    planned.push(instruction);
  }
  assertCrossFillConservation(netByAsset);
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
  for (const instruction of planned) commitCrossFill(pass, instruction);
};
