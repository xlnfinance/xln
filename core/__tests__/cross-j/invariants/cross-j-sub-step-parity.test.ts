import { expect, test } from 'bun:test';
import { withCanonicalCrossJurisdictionRouteHash } from '../../../extensions/cross-j';
import {
  buildCrossJurisdictionCancelInstruction,
  buildCrossJurisdictionFillInstruction,
  buildCrossJurisdictionMarketOffer,
} from '../../../extensions/cross-j/orderbook';
import { normalizeSwapOfferForOrderbook } from '../../../swapbook/swap-execution';

test('cross-j one-leg sub-step preserves progress until full fill or cancellation', () => {
  // Same concrete amounts as Rust cross_j::tests::sub_step. A committed
  // 21845/65535 claims 1/1 of totals 3/5. Execution 1/2 would still claim
  // only 1 on source, so the Hub absorbs it without changing route progress.
  const route = withCanonicalCrossJurisdictionRouteHash({
    orderId: 'order-1', makerEntityId: 'source-user', hubEntityId: 'source-hub',
    source: {
      jurisdiction: 'stack:1:0x1111111111111111111111111111111111111111',
      entityId: 'source-user', counterpartyEntityId: 'source-hub', tokenId: 1, amount: 3n,
    },
    target: {
      jurisdiction: 'stack:2:0x2222222222222222222222222222222222222222',
      entityId: 'target-hub', counterpartyEntityId: 'target-user', tokenId: 1, amount: 5n,
    },
    sourceDisputeConfig: { leftResponseSeconds: 3_600, rightResponseSeconds: 86_400 },
    targetDisputeConfig: { leftResponseSeconds: 3_600, rightResponseSeconds: 86_400 },
    status: 'partially_filled', createdAt: 1_000, updatedAt: 1_000, expiresAt: 61_000,
    fillSeq: 1, fillNumerator: 21_845n, fillDenominator: 65_535n, cumulativeFillRatio: 21_845,
  });
  const offer = normalizeSwapOfferForOrderbook({
    offerId: route.orderId, fromEntity: 'source-user', toEntity: 'source-hub',
    giveTokenId: 1, giveTokenDecimals: 6, giveAmount: 2n,
    wantTokenId: 1, wantTokenDecimals: 6, wantAmount: 4n,
    maxFee: 0n, minNetReceive: 4n, priceTicks: 20_000n, makerIsLeft: true,
    crossJurisdiction: route,
  }, 'source-user');
  const meta = buildCrossJurisdictionMarketOffer(offer, 'source-hub');
  if (!meta) throw new Error('CROSS_J_TEST_META_MISSING');
  const orderId = 'source-user:order-1';
  expect(buildCrossJurisdictionFillInstruction('source-user', route.orderId, orderId, meta, {
    filledLots: 1n, weightedCost: 20_000n,
  })).toBeNull();
  expect(route.cumulativeFillRatio).toBe(21_845);
  const full = buildCrossJurisdictionFillInstruction('source-user', route.orderId, orderId, meta, {
    filledLots: 2n, weightedCost: 40_000n,
  });
  expect(full).toMatchObject({ fillRatio: 65_535, fillSeq: 2, cancelRemainder: false });
  expect(buildCrossJurisdictionCancelInstruction('source-user', route.orderId, orderId, route))
    .toMatchObject({ fillRatio: 21_845, fillSeq: 1, cancelRemainder: true });
});
