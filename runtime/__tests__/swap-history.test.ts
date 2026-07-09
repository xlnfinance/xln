import { describe, expect, test } from 'bun:test';

import {
  recordSwapOfferLifecycle,
  recordSwapResolveLifecycle,
} from '../account-tx/handlers/swap-history';
import type { AccountMachine, SwapOffer } from '../types';

const makeAccount = (): AccountMachine => ({
  leftEntity: 'maker',
  rightEntity: 'hub',
  status: 'active',
  mempool: [],
  currentFrame: {
    height: 0,
    timestamp: 0,
    jHeight: 0,
    accountTxs: [],
    prevFrameHash: '',
    deltas: [],
    stateHash: '',
    byLeft: true,
  },
  deltas: new Map(),
  locks: new Map(),
  swapOffers: new Map(),
  globalCreditLimits: { ownLimit: 0n, peerLimit: 0n },
  currentHeight: 0,
  pendingSignatures: [],
  rollbackCount: 0,
  proofHeader: { fromEntity: 'maker', toEntity: 'hub', nonce: 0 },
  proofBody: { tokenIds: [], deltas: [] },
  frameHistory: [],
  pendingWithdrawals: new Map(),
  requestedRebalance: new Map(),
  requestedRebalanceFeeState: new Map(),
  rebalancePolicy: new Map(),
  leftJObservations: [],
  rightJObservations: [],
  jEventChain: [],
  lastFinalizedJHeight: 0,
  disputeConfig: { leftDisputeDelay: 10, rightDisputeDelay: 10 },
  onChainSettlementNonce: 0,
});

describe('swap order history', () => {
  test('resolve lifecycle is idempotent for retried identical account application', () => {
    const account = makeAccount();
    const offer: SwapOffer = {
      offerId: 'offer-1',
      giveTokenId: 2,
      giveAmount: 40n,
      wantTokenId: 1,
      wantAmount: 100n,
      makerIsLeft: true,
      minFillRatio: 0,
      createdHeight: 1,
      quantizedGive: 40n,
      quantizedWant: 100n,
      priceTicks: 25_000_000n,
    };
    recordSwapOfferLifecycle(account, offer);

    const resolve = {
      fillRatio: 32768,
      fillNumerator: 1n,
      fillDenominator: 2n,
      cancelRemainder: false,
      height: 2,
      executionGiveAmount: 20n,
      executionWantAmount: 50n,
    };

    recordSwapResolveLifecycle(account, offer.offerId, 2, resolve);
    recordSwapResolveLifecycle(account, offer.offerId, 2, { ...resolve });

    const history = account.swapOrderHistory?.get(offer.offerId);
    expect(history?.originalGiveAmount).toBe(40n);
    expect(history?.originalWantAmount).toBe(100n);
    expect(history?.resolves).toHaveLength(1);
  });
});
