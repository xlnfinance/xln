import { applyAccountTxToMutableReplica } from '../../../core/account/tx/apply';
import { createEmptyAccountJClaimAccumulator } from '../../../core/account/j-claims/j-claim-accumulator';
import { createDefaultDelta } from '../../../core/account/state/delta';
import { PersistentAccountStateMap } from '../../../core/account/state/persistent-state-map';
import type { AccountReplica, AccountTx } from '../../../core/types/account';

const entity = (byte: string): string => `0x${byte.repeat(32)}`;
const LEFT = entity('11');
const RIGHT = entity('22');
const FRAME_HASH = `0x${'55'.repeat(32)}`;
const ZERO_ROOT = `0x${'00'.repeat(32)}`;

const makeAccount = (): AccountReplica => {
  const deltas = [1, 2].map(tokenId => {
    const delta = createDefaultDelta(tokenId);
    delta.collateral = 10n ** 24n;
    delta.leftCreditLimit = 10n ** 24n;
    delta.rightCreditLimit = 10n ** 24n;
    return [tokenId, delta] as const;
  });
  return {
    state: {
      leftEntity: LEFT,
      rightEntity: RIGHT,
      domain: { chainId: 31_337, depositoryAddress: `0x${'88'.repeat(20)}` },
      watchSeed: `0x${'99'.repeat(32)}`,
      deltas: PersistentAccountStateMap.fromEntries('deltas', deltas),
      disputeConfig: { leftResponseSeconds: 10, rightResponseSeconds: 10 },
      requestedRebalance: PersistentAccountStateMap.empty('requestedRebalance'),
      requestedRebalanceFeeState: PersistentAccountStateMap.empty('requestedRebalanceFeeState'),
      locks: PersistentAccountStateMap.empty('locks'),
      swapOffers: PersistentAccountStateMap.empty('swapOffers'),
      pulls: PersistentAccountStateMap.empty('pulls'),
      leftPendingJClaims: createEmptyAccountJClaimAccumulator(),
      rightPendingJClaims: createEmptyAccountJClaimAccumulator(),
      lastFinalizedJHeight: 0,
      jNonce: 0,
    },
    status: 'active',
    mempool: [],
    currentFrame: {
      height: 1,
      timestamp: 1_000,
      jHeight: 0,
      accountTxs: [],
      prevFrameHash: FRAME_HASH,
      deltas: [],
      stateHash: FRAME_HASH,
      accountStateRoot: ZERO_ROOT,
      byLeft: true,
    },
    currentHeight: 1,
    rollbackCount: 0,
    proofHeader: { fromEntity: LEFT, toEntity: RIGHT, nextProofNonce: 1 },
    pendingWithdrawals: PersistentAccountStateMap.empty('pendingWithdrawals'),
    shadow: {
      rebalance: {
        policy: PersistentAccountStateMap.empty('rebalanceShadowPolicy'),
        submittedAtByToken: PersistentAccountStateMap.empty('rebalanceShadowSubmitted'),
      },
    },
  };
};

/** One fixed, otherwise valid same-J ask (1 token-2 for 2.5 token-1). */
const swapOffer = (offerId: string): Extract<AccountTx, { type: 'swap_offer' }> => ({
  type: 'swap_offer',
  data: {
    offerId,
    giveTokenId: 2,
    giveTokenDecimals: 18,
    giveAmount: 10n ** 18n,
    wantTokenId: 1,
    wantTokenDecimals: 6,
    wantAmount: 2_500_000n,
    maxFee: 25_000n,
    minNetReceive: 2_475_000n,
    priceTicks: 25_000n,
    timeInForce: 0,
  },
});

/**
 * Producer formats (core/account/swap/swap-command-route.ts, market maker,
 * HLT workload, scenarios) plus every boundary and charset counterexample.
 */
const OFFER_IDS: readonly string[] = [
  'offer-1',
  'swap-lk3fz-1a-0123456789abc',
  'mm-abcdef-2-1-ask-1',
  `mmx-abcdef-123456-2-1-${'a'.repeat(64)}-sell-1`,
  'prod-load-0-realistic-trader-1-1',
  'A.Z_0-9',
  'a'.repeat(256),
  '',
  'a'.repeat(257),
  '€'.repeat(200),
  '￿',
  '\u{10000}',
  'colon:id',
  'space id',
  'slash/id',
  'line\nbreak',
];

export const executeSwapOfferIdAccountSemanticVector = async () => {
  const cases = [];
  for (const offerId of OFFER_IDS) {
    const result = await applyAccountTxToMutableReplica(makeAccount(), swapOffer(offerId), true, 1_000, 1);
    cases.push({
      offerId,
      utf8Bytes: new TextEncoder().encode(offerId).length,
      verdict: result.ok ? 'applied' : 'rejected',
      ...(result.ok ? {} : { code: result.rejection.code, message: result.rejection.message }),
    });
  }
  return {
    version: 1,
    canonicalSource: 'TypeScript Account swap_offer admission',
    offer: swapOffer('<offerId>').data,
    cases,
  };
};
