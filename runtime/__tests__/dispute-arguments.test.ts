import { describe, expect, test } from 'bun:test';
import { ethers } from 'ethers';
import { createEmptyAccountJClaimAccumulator } from '../account/j-claim-accumulator';

import {
  buildDisputeArgumentsForSnapshot,
  captureDisputeArgumentSnapshot,
  storeDisputeArgumentSnapshot,
} from '../protocol/dispute/arguments';
import { buildAccountProofBody } from '../protocol/dispute/proof-builder';
import {
  sanitizeOptionalDisputeArgument,
  sanitizeOptionalDisputeStarterArgumentPair,
} from '../jurisdiction/batch';
import type { AccountMachine, AccountTx, EntityState, SwapOffer } from '../types';

const DELTA_TRANSFORMER = '0x1111111111111111111111111111111111111111';
const TEST_WATCH_SEED = `0x${'d1'.repeat(32)}`;

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
    watchSeed: TEST_WATCH_SEED,
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
    proofHeader: { fromEntity: 'left', toEntity: 'right', nextProofNonce: 1 },
    proofBody: { tokenIds: [], deltas: [] },
    frameHistory: [],
    pendingWithdrawals: new Map(),
    requestedRebalance: new Map(),
    requestedRebalanceFeeState: new Map(),
    shadow: { rebalance: { policy: new Map(), submittedAtByToken: new Map() } },
    leftPendingJClaims: createEmptyAccountJClaimAccumulator(),
    rightPendingJClaims: createEmptyAccountJClaimAccumulator(),
    lastFinalizedJHeight: 0,
    disputeConfig: { leftDisputeDelay: 10, rightDisputeDelay: 10 },
    jNonce: 0,
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
  test('sanitizes malformed optional transformer arguments with a structured warning', () => {
    const result = sanitizeOptionalDisputeArgument('0x1234', 'dispute.test');

    expect(result.value).toBe('0x');
    expect(result.warnings).toEqual([{
      code: 'DISPUTE_OPTIONAL_ARGUMENT_MALFORMED',
      context: 'dispute.test',
      originalBytes: 2,
      limitBytes: 64 * 1024,
    }]);
  });

  test('sanitizes oversized optional transformer arguments instead of blocking dispute', () => {
    const oversized = ethers.AbiCoder.defaultAbiCoder().encode(
      ['bytes[]'],
      [[`0x${'ab'.repeat(64 * 1024)}`]],
    );
    const result = sanitizeOptionalDisputeArgument(oversized, 'dispute.test');

    expect(result.value).toBe('0x');
    expect(result.warnings[0]).toMatchObject({
      code: 'DISPUTE_OPTIONAL_ARGUMENT_OVERSIZED',
      context: 'dispute.test',
      limitBytes: 64 * 1024,
    });
  });

  test('keeps the initial evidence and drops only the suffix when starter arguments exceed their aggregate cap', () => {
    const abi = ethers.AbiCoder.defaultAbiCoder();
    const initial = abi.encode(['bytes[]'], [[`0x${'11'.repeat(40 * 1024)}`]]);
    const incremented = abi.encode(['bytes[]'], [[`0x${'22'.repeat(40 * 1024)}`]]);
    const result = sanitizeOptionalDisputeStarterArgumentPair(initial, incremented, 'dispute.test');

    expect(result.initial).toBe(initial);
    expect(result.incremented).toBe('0x');
    expect(result.warnings.at(-1)).toMatchObject({
      code: 'DISPUTE_OPTIONAL_ARGUMENT_AGGREGATE_OVERSIZED',
      context: 'dispute.test.incremented',
      limitBytes: 64 * 1024,
    });
  });

  test('builds positional swap args from the signed snapshot, not live swap maps', () => {
    const account = accountWithSwaps([
      ['z-right-owned', offer('z-right-owned', false, 2, 1)],
      ['a-left-owned', offer('a-left-owned', true, 1, 2)],
    ]);
    const proof = buildAccountProofBody(account, DELTA_TRANSFORMER);
    storeDisputeArgumentSnapshot(
      account,
      captureDisputeArgumentSnapshot(account, proof.proofBodyHash, 1, proof.proofBodyStruct),
    );

    account.swapOffers.clear();
    account.swapOffers.set('unrelated', offer('unrelated', true, 1, 2));

    const state = {
      entityId: 'left',
      pendingSwapFillRatios: new Map([
        ['right:a-left-owned', 111],
        ['right:z-right-owned', 222],
        ['right:unrelated', 333],
      ]),
    } as unknown as EntityState;

    const args = buildDisputeArgumentsForSnapshot(account, state, 'right', proof.proofBodyHash, {
      secretsSide: 'left',
    });

    expect(decodeFirstRatio(args.leftArguments)).toBe(222);
    expect(decodeFirstRatio(args.rightArguments)).toBe(111);
  });

  test('uses Entity swap intent and ignores the optimistic pending frame completely', () => {
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
      accountTxs: [{
        type: 'swap_resolve',
        data: { offerId: 'remaining-left-owned', fillRatio: 1, cancelRemainder: false },
      } as AccountTx],
      prevFrameHash: 'after-first',
      stateHash: 'pending-second',
      byLeft: false,
      deltas: [],
    };
    const proof = buildAccountProofBody(account, DELTA_TRANSFORMER);
    storeDisputeArgumentSnapshot(
      account,
      captureDisputeArgumentSnapshot(account, proof.proofBodyHash, 1, proof.proofBodyStruct),
    );
    const state = {
      entityId: 'left',
      pendingSwapFillRatios: new Map([['right:remaining-left-owned', 32_768]]),
    } as unknown as EntityState;
    const args = buildDisputeArgumentsForSnapshot(
      account,
      state,
      'right',
      proof.proofBodyHash,
      { secretsSide: 'left' },
    );
    expect(decodeFirstRatio(args.rightArguments)).toBe(32768);
    const withoutIntent = buildDisputeArgumentsForSnapshot(
      account,
      { entityId: 'left', pendingSwapFillRatios: new Map() } as unknown as EntityState,
      'right',
      proof.proofBodyHash,
      { secretsSide: 'left' },
    );
    expect(withoutIntent.rightArguments).toBe('0x');
  });

  test('isolates invalid or unplanned Entity swap evidence per signed offer', () => {
    const account = accountWithSwaps([
      ['invalid', offer('invalid', true, 1, 2)],
      ['valid', offer('valid', true, 1, 2)],
    ]);
    const proof = buildAccountProofBody(account, DELTA_TRANSFORMER);
    storeDisputeArgumentSnapshot(
      account,
      captureDisputeArgumentSnapshot(account, proof.proofBodyHash, 1, proof.proofBodyStruct),
    );

    const state = {
      entityId: 'left',
      pendingSwapFillRatios: new Map([
        ['right:invalid', 65_536],
        ['right:valid', 32_768],
        ['right:unplanned', 12_345],
      ]),
    } as unknown as EntityState;
    const args = buildDisputeArgumentsForSnapshot(
      account,
      state,
      'right',
      proof.proofBodyHash,
      { secretsSide: 'left' },
    );
    const abi = ethers.AbiCoder.defaultAbiCoder();
    const [wrapped] = abi.decode(['bytes[]'], args.rightArguments) as unknown as [string[]];
    const [decoded] = abi.decode(
      ['tuple(uint16[] fillRatios, bytes32[] secrets, bytes[] pulls)'],
      wrapped[0]!,
    ) as unknown as [{ fillRatios: bigint[] }];
    expect(Array.from(decoded.fillRatios, Number)).toEqual([0, 32_768]);
  });

  test('ignores malformed optional HTLC secrets but still requires the exact proof snapshot', () => {
    const account = accountWithSwaps([]);
    account.locks.set('lock', {
      lockId: 'lock',
      hashlock: `0x${'ab'.repeat(32)}`,
      timelock: 100_000n,
      amount: 1n,
      tokenId: 1,
      senderIsLeft: true,
      createdHeight: 1,
      createdTimestamp: 1,
    });
    account.pulls.set('pull', {
      pullId: 'pull',
      tokenId: 1,
      amount: 1n,
      revealedUntilTimestamp: 100,
      fullHash: `0x${'cd'.repeat(32)}`,
      partialRoot: `0x${'ef'.repeat(32)}`,
      createdHeight: 1,
      createdTimestamp: 1,
    });
    const proof = buildAccountProofBody(account, DELTA_TRANSFORMER);
    storeDisputeArgumentSnapshot(
      account,
      captureDisputeArgumentSnapshot(account, proof.proofBodyHash, 1, proof.proofBodyStruct),
    );
    const state = {
      entityId: 'left',
      htlcRoutes: new Map([['bad-secret', {
        secret: '0x1234',
        inboundEntity: 'right',
      }]]),
    } as unknown as EntityState;
    account.mempool = [
      { type: 'pull_resolve', data: { pullId: 'pull', binary: '0x1234' } } as AccountTx,
      { type: 'pull_resolve', data: { pullId: 'pull', binary: '0x5678' } } as AccountTx,
    ];

    const args = buildDisputeArgumentsForSnapshot(account, state, 'right', proof.proofBodyHash, {
      secretsSide: 'left',
    });
    expect(args.leftArguments).toBe('0x');
    expect(() => buildDisputeArgumentsForSnapshot(account, state, 'right', `0x${'ff'.repeat(32)}`, {
      secretsSide: 'left',
    })).toThrow('DISPUTE_ARGUMENT_SNAPSHOT_MISSING');
  });
});
