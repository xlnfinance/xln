import { describe, expect, test } from 'bun:test';
import { ethers } from 'ethers';

import {
  buildDisputeArgumentsForSnapshot,
  captureDisputeArgumentSnapshot,
  storeDisputeArgumentSnapshot,
} from '../dispute-arguments';
import { buildAccountProofBody, setDeltaTransformerAddress } from '../proof-builder';
import { asOfferId, swapKey } from '../swap-keys';
import type { AccountMachine, EntityState, SwapOffer } from '../types';

const DELTA_TRANSFORMER = '0x1111111111111111111111111111111111111111';

function offer(offerId: string, makerIsLeft: boolean, giveTokenId: number, wantTokenId: number): SwapOffer {
  return {
    offerId,
    giveTokenId,
    giveAmount: 100n,
    wantTokenId,
    wantAmount: 200n,
    makerIsLeft,
    minFillRatio: 0,
    createdHeight: 1,
    quantizedGive: 100n,
    quantizedWant: 200n,
  };
}

function accountWithSwaps(swaps: Array<[string, SwapOffer]>): AccountMachine {
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
      stateHash: '',
      byLeft: true,
      deltas: [],
    },
    deltas: new Map([
      [1, { tokenId: 1, collateral: 0n, ondelta: 0n, offdelta: 0n, leftCreditLimit: 0n, rightCreditLimit: 0n, leftAllowance: 0n, rightAllowance: 0n }],
      [2, { tokenId: 2, collateral: 0n, ondelta: 0n, offdelta: 0n, leftCreditLimit: 0n, rightCreditLimit: 0n, leftAllowance: 0n, rightAllowance: 0n }],
    ]),
    locks: new Map(),
    pulls: new Map(),
    swapOffers: new Map(swaps),
    globalCreditLimits: { ownLimit: 0n, peerLimit: 0n },
    currentHeight: 0,
    pendingSignatures: [],
    rollbackCount: 0,
    proofHeader: { fromEntity: 'left', toEntity: 'right', nonce: 1 },
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

function decodeFirstRatio(wrapped: string): number {
  const abi = ethers.AbiCoder.defaultAbiCoder();
  const [items] = abi.decode(['bytes[]'], wrapped) as unknown as [string[]];
  const [decoded] = abi.decode(
    ['tuple(uint16[] fillRatios, bytes32[] secrets, bytes[] pulls)'],
    items[0]!,
  ) as unknown as [{ fillRatios: bigint[] }];
  return Number(decoded.fillRatios[0] || 0n);
}

describe('dispute argument snapshots', () => {
  test('builds positional swap args from the signed snapshot, not live swap maps', () => {
    setDeltaTransformerAddress(DELTA_TRANSFORMER);
    const account = accountWithSwaps([
      ['z-right-owned', offer('z-right-owned', false, 2, 1)],
      ['a-left-owned', offer('a-left-owned', true, 1, 2)],
    ]);
    const proof = buildAccountProofBody(account);
    storeDisputeArgumentSnapshot(
      account,
      captureDisputeArgumentSnapshot(account, proof.proofBodyHash, 1, proof.proofBodyStruct),
    );

    account.swapOffers.clear();
    account.swapOffers.set('unrelated', offer('unrelated', true, 1, 2));

    const state = {
      entityId: 'left',
      pendingSwapFillRatios: new Map([
        [swapKey('right', asOfferId('a-left-owned')), 111],
        [swapKey('right', asOfferId('z-right-owned')), 222],
      ]),
    } as unknown as EntityState;

    const args = buildDisputeArgumentsForSnapshot(account, state, 'right', proof.proofBodyHash, {
      secretsSide: 'left',
    });

    expect(decodeFirstRatio(args.leftArguments)).toBe(222);
    expect(decodeFirstRatio(args.rightArguments)).toBe(111);
  });
});
