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
    orderId: 'order-1', makerEntityId: '0x2222222222222222222222222222222222222222222222222222222222222222', hubEntityId: '0x1111111111111111111111111111111111111111111111111111111111111111',
    source: {
      jurisdiction: 'stack:1:0x1111111111111111111111111111111111111111',
      entityId: '0x2222222222222222222222222222222222222222222222222222222222222222', counterpartyEntityId: '0x1111111111111111111111111111111111111111111111111111111111111111', tokenId: 1, amount: 3n,
    },
    target: {
      jurisdiction: 'stack:2:0x2222222222222222222222222222222222222222',
      entityId: '0x3333333333333333333333333333333333333333333333333333333333333333', counterpartyEntityId: '0x4444444444444444444444444444444444444444444444444444444444444444', tokenId: 1, amount: 5n,
    },
    sourceDisputeConfig: { leftResponseSeconds: 3_600, rightResponseSeconds: 86_400 },
    targetDisputeConfig: { leftResponseSeconds: 3_600, rightResponseSeconds: 86_400 },
    status: 'partially_filled', createdAt: 1_000, updatedAt: 1_000, expiresAt: 61_000,
    fillSeq: 1, fillNumerator: 21_845n, fillDenominator: 65_535n, cumulativeFillRatio: 21_845,
  });
  const offer = normalizeSwapOfferForOrderbook({
    offerId: route.orderId, fromEntity: '0x2222222222222222222222222222222222222222222222222222222222222222', toEntity: '0x1111111111111111111111111111111111111111111111111111111111111111',
    giveTokenId: 1, giveTokenDecimals: 6, giveAmount: 2n,
    wantTokenId: 1, wantTokenDecimals: 6, wantAmount: 4n,
    maxFee: 0n, minNetReceive: 4n, priceTicks: 20_000n, makerIsLeft: true,
    crossJurisdiction: route,
  }, '0x2222222222222222222222222222222222222222222222222222222222222222');
  const meta = buildCrossJurisdictionMarketOffer(offer, '0x1111111111111111111111111111111111111111111111111111111111111111');
  if (!meta) throw new Error('CROSS_J_TEST_META_MISSING');
  const orderId = '0x2222222222222222222222222222222222222222222222222222222222222222:order-1';
  expect(buildCrossJurisdictionFillInstruction('0x2222222222222222222222222222222222222222222222222222222222222222', route.orderId, orderId, meta, {
    filledLots: 1n, weightedCost: 20_000n,
  })).toBeNull();
  expect(route.cumulativeFillRatio).toBe(21_845);
  const full = buildCrossJurisdictionFillInstruction('0x2222222222222222222222222222222222222222222222222222222222222222', route.orderId, orderId, meta, {
    filledLots: 2n, weightedCost: 40_000n,
  });
  expect(full).toMatchObject({ fillRatio: 65_535, fillSeq: 2, cancelRemainder: false });
  expect(buildCrossJurisdictionCancelInstruction('0x2222222222222222222222222222222222222222222222222222222222222222', route.orderId, orderId, route))
    .toMatchObject({ fillRatio: 21_845, fillSeq: 1, cancelRemainder: true });
});
