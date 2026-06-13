import { describe, expect, test } from 'bun:test';
import { ethers } from 'ethers';

import {
  buildDisputeArgumentsForSnapshot,
  captureDisputeArgumentSnapshot,
  storeDisputeArgumentSnapshot,
} from '../dispute-arguments';
import { buildAccountProofBody, setDeltaTransformerAddress } from '../proof-builder';
import type { AccountMachine, AccountTx, EntityState, SwapOffer } from '../types';

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
  if (wrapped === '0x') return 0;
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

    account.mempool.push(
      { type: 'swap_resolve', data: { offerId: 'a-left-owned', fillRatio: 111, cancelRemainder: false } } as AccountTx,
      { type: 'swap_resolve', data: { offerId: 'z-right-owned', fillRatio: 222, cancelRemainder: false } } as AccountTx,
    );
    const state = { entityId: 'left' } as unknown as EntityState;

    const args = buildDisputeArgumentsForSnapshot(account, state, 'right', proof.proofBodyHash, {
      secretsSide: 'left',
    });

    expect(decodeFirstRatio(args.leftArguments)).toBe(222);
    expect(decodeFirstRatio(args.rightArguments)).toBe(111);
  });

  test('does not reapply a pending swap fill to the proof body that already contains it', () => {
    setDeltaTransformerAddress(DELTA_TRANSFORMER);
    const secondFill = {
      type: 'swap_resolve',
      data: {
        offerId: 'remaining-left-owned',
        fillRatio: 32768,
        fillNumerator: 1n,
        fillDenominator: 2n,
        executionGiveAmount: 25n,
        executionWantAmount: 50n,
        cancelRemainder: false,
      },
    } as AccountTx;

    const afterFirstFill = accountWithSwaps([
      ['remaining-left-owned', {
        ...offer('remaining-left-owned', true, 1, 2),
        giveAmount: 50n,
        wantAmount: 100n,
        quantizedGive: 50n,
        quantizedWant: 100n,
      }],
    ]);
    afterFirstFill.pendingFrame = {
      height: 2,
      timestamp: 20,
      jHeight: 0,
      accountTxs: [secondFill],
      prevFrameHash: 'after-first',
      stateHash: 'pending-second',
      byLeft: false,
      deltas: [],
    };
    const initialProof = buildAccountProofBody(afterFirstFill);
    storeDisputeArgumentSnapshot(
      afterFirstFill,
      captureDisputeArgumentSnapshot(afterFirstFill, initialProof.proofBodyHash, 1, initialProof.proofBodyStruct),
    );

    const initialArgs = buildDisputeArgumentsForSnapshot(
      afterFirstFill,
      { entityId: 'left' } as unknown as EntityState,
      'right',
      initialProof.proofBodyHash,
      { secretsSide: 'left' },
    );
    expect(decodeFirstRatio(initialArgs.rightArguments)).toBe(32768);

    const afterSecondFill = accountWithSwaps([
      ['remaining-left-owned', {
        ...offer('remaining-left-owned', true, 1, 2),
        giveAmount: 25n,
        wantAmount: 50n,
        quantizedGive: 25n,
        quantizedWant: 50n,
      }],
    ]);
    afterSecondFill.pendingFrame = structuredClone(afterFirstFill.pendingFrame);
    const incrementedProof = buildAccountProofBody(afterSecondFill);
    storeDisputeArgumentSnapshot(
      afterSecondFill,
      captureDisputeArgumentSnapshot(afterSecondFill, incrementedProof.proofBodyHash, 2, incrementedProof.proofBodyStruct, {
        appliedAccountTxs: [secondFill],
        appliedFrameHeight: 2,
      }),
    );

    const incrementedArgs = buildDisputeArgumentsForSnapshot(
      afterSecondFill,
      { entityId: 'left' } as unknown as EntityState,
      'right',
      incrementedProof.proofBodyHash,
      { secretsSide: 'left' },
    );
    expect(incrementedArgs.rightArguments).toBe('0x');
  });

  test('does not suppress an identical swap fill when it belongs to a later pending frame', () => {
    setDeltaTransformerAddress(DELTA_TRANSFORMER);
    const repeatedFill = {
      type: 'swap_resolve',
      data: {
        offerId: 'remaining-left-owned',
        fillRatio: 32768,
        fillNumerator: 1n,
        fillDenominator: 2n,
        executionGiveAmount: 25n,
        executionWantAmount: 50n,
        cancelRemainder: false,
      },
    } as AccountTx;
    const account = accountWithSwaps([
      ['remaining-left-owned', {
        ...offer('remaining-left-owned', true, 1, 2),
        giveAmount: 50n,
        wantAmount: 100n,
        quantizedGive: 50n,
        quantizedWant: 100n,
      }],
    ]);
    account.pendingFrame = {
      height: 2,
      timestamp: 20,
      jHeight: 0,
      accountTxs: [repeatedFill],
      prevFrameHash: 'after-first',
      stateHash: 'pending-second',
      byLeft: false,
      deltas: [],
    };
    const proof = buildAccountProofBody(account);
    storeDisputeArgumentSnapshot(
      account,
      captureDisputeArgumentSnapshot(account, proof.proofBodyHash, 1, proof.proofBodyStruct, {
        appliedAccountTxs: [repeatedFill],
        appliedFrameHeight: 1,
      }),
    );

    const args = buildDisputeArgumentsForSnapshot(
      account,
      { entityId: 'left' } as unknown as EntityState,
      'right',
      proof.proofBodyHash,
      { secretsSide: 'left' },
    );
    expect(decodeFirstRatio(args.rightArguments)).toBe(32768);
  });

  test('fails fast when applied fill identity is missing the frame height', () => {
    setDeltaTransformerAddress(DELTA_TRANSFORMER);
    const fill = {
      type: 'swap_resolve',
      data: {
        offerId: 'remaining-left-owned',
        fillRatio: 32768,
        fillNumerator: 1n,
        fillDenominator: 2n,
        executionGiveAmount: 25n,
        executionWantAmount: 50n,
        cancelRemainder: false,
      },
    } as AccountTx;
    const account = accountWithSwaps([
      ['remaining-left-owned', offer('remaining-left-owned', true, 1, 2)],
    ]);
    account.pendingFrame = {
      height: 2,
      timestamp: 20,
      jHeight: 0,
      accountTxs: [fill],
      prevFrameHash: 'after-first',
      stateHash: 'pending-second',
      byLeft: false,
      deltas: [],
    };
    const proof = buildAccountProofBody(account);
    storeDisputeArgumentSnapshot(
      account,
      captureDisputeArgumentSnapshot(account, proof.proofBodyHash, 1, proof.proofBodyStruct, {
        appliedAccountTxs: [fill],
      }),
    );

    expect(() => buildDisputeArgumentsForSnapshot(
      account,
      { entityId: 'left' } as unknown as EntityState,
      'right',
      proof.proofBodyHash,
      { secretsSide: 'left' },
    )).toThrow('DISPUTE_ARGUMENT_APPLIED_FRAME_HEIGHT_MISSING');
  });

  test('derives dispute uint16 fill projection from exact ratio and rejects coarse drift', () => {
    setDeltaTransformerAddress(DELTA_TRANSFORMER);
    const account = accountWithSwaps([
      ['left-owned', offer('left-owned', true, 1, 2)],
    ]);
    const proof = buildAccountProofBody(account);
    storeDisputeArgumentSnapshot(
      account,
      captureDisputeArgumentSnapshot(account, proof.proofBodyHash, 1, proof.proofBodyStruct),
    );

    account.mempool.push({
      type: 'swap_resolve',
      data: {
        offerId: 'left-owned',
        fillRatio: 16_384,
        fillNumerator: 1n,
        fillDenominator: 4n,
        cancelRemainder: false,
      },
    } as AccountTx);

    const args = buildDisputeArgumentsForSnapshot(
      account,
      { entityId: 'left' } as unknown as EntityState,
      'right',
      proof.proofBodyHash,
      { secretsSide: 'left' },
    );
    expect(decodeFirstRatio(args.rightArguments)).toBe(16_384);

    account.mempool = [{
      type: 'swap_resolve',
      data: {
        offerId: 'left-owned',
        fillRatio: 16_383,
        fillNumerator: 1n,
        fillDenominator: 4n,
        cancelRemainder: false,
      },
    } as AccountTx];

    expect(() => buildDisputeArgumentsForSnapshot(
      account,
      { entityId: 'left' } as unknown as EntityState,
      'right',
      proof.proofBodyHash,
      { secretsSide: 'left' },
    )).toThrow(/DISPUTE_ARGUMENT_SWAP_FILL_RATIO_MISMATCH/);
  });
});
