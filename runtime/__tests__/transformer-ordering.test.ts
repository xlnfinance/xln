import { describe, expect, test } from 'bun:test';
import { buildAccountProofBody, setDeltaTransformerAddress } from '../proof-builder';
import { buildPositionalSwapFillRatioBuckets, sortTransformerEntries } from '../transformer-ordering';
import { asOfferId } from '../swap-keys';
import type { AccountMachine, SwapOffer } from '../types';

const MAX_FILL_RATIO = 65535n;
const DELTA_TRANSFORMER = '0x1111111111111111111111111111111111111111';

function makeSwapOffer(
  offerId: string,
  makerIsLeft: boolean,
  giveTokenId: number,
  giveAmount: bigint,
  wantTokenId: number,
  wantAmount: bigint,
): SwapOffer {
  return {
    offerId,
    giveTokenId,
    giveAmount,
    wantTokenId,
    wantAmount,
    makerIsLeft,
    minFillRatio: 0,
    createdHeight: 0,
    quantizedGive: giveAmount,
    quantizedWant: wantAmount,
  };
}

function makeProofAccountMachine(swaps: Array<[string, SwapOffer]>): AccountMachine {
  return {
    leftEntity: 'left',
    rightEntity: 'right',
    status: 'active',
    mempool: [],
    currentFrame: {
      height: 0,
      timestamp: 0,
      jHeight: 0,
      accountTxs: [],
      prevFrameHash: '',
      tokenIds: [],
      deltas: [],
      stateHash: '',
      byLeft: true,
    },
    deltas: new Map([
      [1, { tokenId: 1, collateral: 0n, ondelta: 0n, offdelta: 0n, leftCreditLimit: 0n, rightCreditLimit: 0n, leftAllowance: 0n, rightAllowance: 0n }],
      [2, { tokenId: 2, collateral: 0n, ondelta: 0n, offdelta: 0n, leftCreditLimit: 0n, rightCreditLimit: 0n, leftAllowance: 0n, rightAllowance: 0n }],
    ]),
    locks: new Map(),
    swapOffers: new Map(swaps),
    globalCreditLimits: { ownLimit: 0n, peerLimit: 0n },
    currentHeight: 0,
    pendingSignatures: [],
    rollbackCount: 0,
    proofHeader: { fromEntity: 'left', toEntity: 'right', nonce: 0 },
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
  };
}

function applyDeltaTransformerStyleSwaps(
  swaps: Array<{ ownerIsLeft: boolean; addDeltaIndex: number; addAmount: bigint; subDeltaIndex: number; subAmount: bigint }>,
  leftFillRatios: number[],
  rightFillRatios: number[],
): bigint[] {
  const deltas = [0n, 0n];
  let leftIndex = 0;
  let rightIndex = 0;

  for (const swap of swaps) {
    const fillRatio = swap.ownerIsLeft ? rightFillRatios[rightIndex++] ?? 0 : leftFillRatios[leftIndex++] ?? 0;
    const ratio = BigInt(fillRatio);
    deltas[swap.addDeltaIndex] += (swap.addAmount * ratio) / MAX_FILL_RATIO;
    deltas[swap.subDeltaIndex] -= (swap.subAmount * ratio) / MAX_FILL_RATIO;
  }

  return deltas;
}

describe('transformer ordering', () => {
  test('sortTransformerEntries uses canonical string order, not insertion order', () => {
    const entries = new Map<string, number>([
      ['b2', 1],
      ['a2', 2],
      ['A', 3],
      ['10', 4],
    ]);

    const sortedKeys = sortTransformerEntries(entries.entries()).map(([key]) => key);
    expect(sortedKeys).toEqual(['10', 'A', 'a2', 'b2']);
  });

  test('buildPositionalSwapFillRatioBuckets keeps left/right arrays aligned to canonical sorted swaps', () => {
    const swaps = new Map<string, { makerIsLeft: boolean }>([
      ['b2', { makerIsLeft: false }],
      ['a10', { makerIsLeft: true }],
      ['a2', { makerIsLeft: true }],
      ['b1', { makerIsLeft: false }],
    ]);
    const fillRatiosByOfferId = new Map([
      [asOfferId('a10'), 101],
      [asOfferId('a2'), 202],
      [asOfferId('b1'), 303],
      [asOfferId('b2'), 404],
    ]);

    const { leftFillRatios, rightFillRatios } = buildPositionalSwapFillRatioBuckets(
      swaps.entries(),
      fillRatiosByOfferId,
    );

    expect(leftFillRatios).toEqual([303, 404]);
    expect(rightFillRatios).toEqual([101, 202]);
  });

  test('proof-body swap order stays aligned with positional fill ratios for mixed sides', () => {
    setDeltaTransformerAddress(DELTA_TRANSFORMER);

    const accountMachine = makeProofAccountMachine([
      ['b2', makeSwapOffer('b2', false, 2, 400n, 1, 800n)],
      ['a10', makeSwapOffer('a10', true, 1, 100n, 2, 200n)],
      ['a2', makeSwapOffer('a2', true, 1, 200n, 2, 500n)],
      ['b1', makeSwapOffer('b1', false, 2, 300n, 1, 700n)],
    ]);

    const fillRatiosByOfferId = new Map([
      [asOfferId('a10'), 65535],
      [asOfferId('a2'), 32768],
      [asOfferId('b1'), 16384],
      [asOfferId('b2'), 8192],
    ]);

    const proofBody = buildAccountProofBody(accountMachine);
    const transformer = proofBody.runtimeProofBody.transformers[0];
    expect(transformer).toBeDefined();
    const swaps = transformer.batch.swaps;

    const { leftFillRatios, rightFillRatios } = buildPositionalSwapFillRatioBuckets(
      accountMachine.swapOffers.entries(),
      fillRatiosByOfferId,
    );

    expect(swaps.map((swap) => swap.addAmount)).toEqual([100n, 200n, 300n, 400n]);
    expect(swaps.map((swap) => swap.ownerIsLeft)).toEqual([true, true, false, false]);
    expect(leftFillRatios).toEqual([16384, 8192]);
    expect(rightFillRatios).toEqual([65535, 32768]);

    const contractStyleDeltas = applyDeltaTransformerStyleSwaps(swaps, leftFillRatios, rightFillRatios);

    const expectedByOffer = [0n, 0n];
    for (const [offerId, offer] of sortTransformerEntries(accountMachine.swapOffers.entries())) {
      const ratio = BigInt(fillRatiosByOfferId.get(asOfferId(offerId)) ?? 0);
      const addDeltaIndex = offer.giveTokenId - 1;
      const subDeltaIndex = offer.wantTokenId - 1;
      expectedByOffer[addDeltaIndex] += (offer.giveAmount * ratio) / MAX_FILL_RATIO;
      expectedByOffer[subDeltaIndex] -= (offer.wantAmount * ratio) / MAX_FILL_RATIO;
    }

    expect(contractStyleDeltas).toEqual(expectedByOffer);
  });
});
