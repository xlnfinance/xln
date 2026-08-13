import { haltRuntimeFailure } from "../../../../../../protocol/errors/failure-taxonomy";

import { createStructuredLogger, shortOrder } from '../../../../../../infra/logger';
import { compareCanonicalText } from '../../../../../../orderbook/swap-execution';
import {
  buildCrossJurisdictionFillAck,
} from '../../../../../../extensions/cross-j/orderbook';
import { crossJurisdictionAssetKey } from '../../../../../../extensions/cross-j/market';
import { buildCrossJurisdictionPendingFillFromAck } from '../../../../../../extensions/cross-j/fill-ack';
import {
  buildCrossMarketOfferFromBookOrder,
  parseNamespacedOrderId,
} from '../helpers';
import { hasQueuedCrossSwapAckForEntityState } from '../queue';
import { getCrossAdmission } from './pass';
import { removeCrossBookOrderAfterFill } from './book';
import type { CrossOrderbookPass } from './types';

const orderbookCrossLog = createStructuredLogger('orderbook.cross');
type PlannedCrossAck = NonNullable<
  ReturnType<typeof buildCrossJurisdictionFillAck>
>;

const assertPlannedCrossAckConservation = (
  plans: readonly PlannedCrossAck[],
): void => {
  const netByAsset = new Map<string, bigint>();
  for (const { instruction } of plans) {
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

const planCrossAcks = (pass: CrossOrderbookPass): PlannedCrossAck[] => {
  const planned: PlannedCrossAck[] = [];
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
    if (
      hasQueuedCrossSwapAckForEntityState(
        pass.hubState,
        accountId,
        offerId,
      )
    ) {
      pass.suspendedOrderIds.add(orderId);
      continue;
    }
    const ack = buildCrossJurisdictionFillAck(
      accountId,
      offerId,
      orderId,
      meta,
      fill,
    );
    if (!ack) {
      throw haltRuntimeFailure("ORDERBOOK_CROSS_J_FILL_ACK_MISSING", `ORDERBOOK_CROSS_J_FILL_ACK_MISSING: order=${orderId} ` +
        `account=${accountId} offer=${offerId} filledLots=${fill.filledLots}`);
    }
    planned.push(ack);
  }
  return planned;
};

const commitCrossAck = (
  pass: CrossOrderbookPass,
  ack: PlannedCrossAck,
): void => {
  const { accountId, offerId, orderId } = ack.instruction;
  const meta =
    pass.crossLiveOfferMeta.get(orderId) ??
    buildCrossMarketOfferFromBookOrder(pass.hubState, orderId);
  if (!meta) {
    throw haltRuntimeFailure("ORDERBOOK_CROSS_J_FILL_META_MISSING", `ORDERBOOK_CROSS_J_FILL_META_MISSING: order=${orderId}`);
  }
  const admission = getCrossAdmission(pass, accountId, offerId);
  if (admission) {
    const pendingFill = buildCrossJurisdictionPendingFillFromAck(
      ack.tx,
      Number(pass.hubState.timestamp || 0),
    );
    if (pendingFill) admission.pendingFill = pendingFill;
    else delete admission.pendingFill;
    admission.updatedAt = Number(
      pass.hubState.timestamp || admission.updatedAt || 0,
    );
  }
  orderbookCrossLog.debug('ack', {
    account: shortOrder(accountId, 12),
    offer: shortOrder(offerId, 12),
    cancel: ack.tx.data.cancelRemainder,
    ratio: ack.tx.data.cumulativeFillRatio,
    exact:
      ack.tx.data.fillNumerator !== undefined &&
      ack.tx.data.fillDenominator !== undefined
        ? `${ack.tx.data.fillNumerator}/${ack.tx.data.fillDenominator}`
        : 'none',
    source: ack.tx.data.cumulativeSourceAmount?.toString(),
  });
  if (ack.tx.data.cancelRemainder) {
    removeCrossBookOrderAfterFill(
      pass,
      meta.pairId,
      orderId,
      'cross-fill-ack-terminal',
    );
  }
  pass.crossJurisdictionFills.push(ack.instruction);
  pass.accountTxs.push({ accountId, tx: ack.tx });
};

export const finalizeCrossOrderbookAcks = (
  pass: CrossOrderbookPass,
): void => {
  // Plan every leg before any Account mempool or admission mutation.
  const planned = planCrossAcks(pass);
  assertPlannedCrossAckConservation(planned);
  for (const ack of planned) commitCrossAck(pass, ack);
};
