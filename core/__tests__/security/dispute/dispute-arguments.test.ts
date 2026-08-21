import { describe, expect, test } from 'bun:test';
import { ethers } from 'ethers';
import { createEmptyAccountJClaimAccumulator } from '../../../account/j-claims/j-claim-accumulator';

import {
  buildCurrentDisputeArgumentPlan,
  buildDisputeArgumentsFromState,
} from '../../../protocol/dispute/arguments';
import {
  J_BATCH_CONTRACT_LIMITS,
  sanitizeOptionalDisputeArgument,
  sanitizeOptionalDisputeStarterArgumentPair,
} from '../../../jurisdiction/machine/batch';
import { LIMITS } from '../../../config/constants';
import type { AccountReplica, AccountTx, SwapOffer } from '../../../types/account';
const TEST_WATCH_SEED = `0x${'d1'.repeat(32)}`;

function offer(offerId: string, makerIsLeft: boolean, giveTokenId: number, wantTokenId: number): SwapOffer {
  return {
    offerId,
    giveTokenId,
    giveAmount: 100n,
    wantTokenId,
    wantAmount: 200n,
    makerIsLeft,
    createdHeight: 1,
    quantizedGive: 100n,
    quantizedWant: 200n,
  };
}

function accountWithSwaps(swaps: Array<[string, SwapOffer]>): AccountReplica {
  return {
    state: {
      leftEntity: 'left',
      rightEntity: 'right',
      domain: {
        chainId: 31337,
        depositoryAddress: '0x1111111111111111111111111111111111111111',
      },
      watchSeed: TEST_WATCH_SEED,
      deltas: new Map([
        [1, { tokenId: 1, collateral: 0n, ondelta: 0n, offdelta: 0n, leftCreditLimit: 0n, rightCreditLimit: 0n, leftAllowance: 0n, rightAllowance: 0n }],
        [2, { tokenId: 2, collateral: 0n, ondelta: 0n, offdelta: 0n, leftCreditLimit: 0n, rightCreditLimit: 0n, leftAllowance: 0n, rightAllowance: 0n }],
      ]),
      locks: new Map(),
      pulls: new Map(),
      swapOffers: new Map(swaps),
      requestedRebalance: new Map(),
      requestedRebalanceFeeState: new Map(),
      leftPendingJClaims: createEmptyAccountJClaimAccumulator(),
      rightPendingJClaims: createEmptyAccountJClaimAccumulator(),
      lastFinalizedJHeight: 0,
      disputeConfig: { leftResponseSeconds: 10, rightResponseSeconds: 10 },
      jNonce: 0,
    },
    status: 'active',
    mempool: [],
    currentFrame: {
      height: 0,
      timestamp: 0,
      jHeight: 0,
      accountTxs: [],
      prevFrameHash: '',
      accountStateRoot: `0x${'00'.repeat(32)}`,
      stateHash: '',
      byLeft: true,
      deltas: [],
    },
    currentHeight: 0,
    rollbackCount: 0,
    proofHeader: { fromEntity: 'left', toEntity: 'right', nextProofNonce: 1 },
    pendingWithdrawals: new Map(),
    shadow: { rebalance: { policy: new Map(), submittedAtByToken: new Map() } },
  };
}

function decodeFirstRatio(wrapped: string): number {
  if (wrapped === '0x') return 0;
  const abi = ethers.AbiCoder.defaultAbiCoder();
  const [items] = abi.decode(['bytes[]'], wrapped) as unknown as [string[]];
  const [decoded] = abi.decode(
    ['tuple(uint16[] fillRatios, bytes32[] secrets)'],
    items[0]!,
  ) as unknown as [{ fillRatios: bigint[] }];
  return Number(decoded.fillRatios[0] || 0n);
}

describe('frozen AccountState dispute arguments', () => {
  test('derives a detached positional plan from the one canonical AccountState', () => {
    const account = accountWithSwaps([
      ['left-owned', offer('left-owned', true, 1, 2)],
    ]);
    const plan = buildCurrentDisputeArgumentPlan(account);

    account.state.swapOffers.clear();

    expect(plan.leftSwapOfferIds).toEqual([]);
    expect(plan.rightSwapOfferIds).toEqual(['left-owned']);
    expect(buildCurrentDisputeArgumentPlan(account).rightSwapOfferIds).toEqual([]);
  });

  test('reduces malformed dynamic transformer arguments to empty evidence with a warning', () => {
    const result = sanitizeOptionalDisputeArgument('0x1234', 'dispute.test');

    expect(result.value).toBe('0x');
    expect(result.warnings).toEqual([{
      code: 'DISPUTE_OPTIONAL_ARGUMENT_MALFORMED',
      context: 'dispute.test',
      originalBytes: 2,
      limitBytes: 64 * 1024,
    }]);
  });

  test('reduces oversized dynamic transformer arguments to empty evidence with a warning', () => {
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
    const counter = abi.encode(['bytes[]'], [[`0x${'22'.repeat(40 * 1024)}`]]);
    const result = sanitizeOptionalDisputeStarterArgumentPair(initial, counter, 'dispute.test');

    expect(result.initial).toBe(initial);
    expect(result.counter).toBe('0x');
    expect(result.warnings.at(-1)).toMatchObject({
      code: 'DISPUTE_OPTIONAL_ARGUMENT_AGGREGATE_OVERSIZED',
      context: 'dispute.test.counter',
      limitBytes: 64 * 1024,
    });
  });

  test('keeps maximum honest dynamic arguments within the jurisdiction byte cap', () => {
    const abi = ethers.AbiCoder.defaultAbiCoder();
    const encodeArguments = (
      fillRatioCount: number,
      secretCount: number,
      canonicalArgumentClauseCount: 1 | 2,
    ): string => {
      const transformerArgs = abi.encode(
        ['tuple(uint16[] fillRatios, bytes32[] secrets)'],
        [{
          fillRatios: Array.from({ length: fillRatioCount }, () => 0xffff),
          secrets: Array.from(
            { length: secretCount },
            (_, index) => `0x${(index + 1).toString(16).padStart(64, '0')}`,
          ),
        }],
      );
      return abi.encode(['bytes[]'], [
        Array.from({ length: canonicalArgumentClauseCount }, () => transformerArgs),
      ]);
    };
    const encodedBytes = (value: string): number => ethers.getBytes(value).length;
    const maxOffers = LIMITS.MAX_ACCOUNT_SAME_J_SWAP_OFFERS;
    const maxSecrets = LIMITS.MAX_ACCOUNT_HTLC_LOCKS;

    // All live same-j offers may belong to one maker side, and every live HTLC
    // may reveal a secret on that same side. This is the largest honest wrapper
    // one participant can supply for the signed DeltaTransformer plan.
    const maximumSide = encodeArguments(maxOffers, maxSecrets, 2);
    expect(encodedBytes(maximumSide)).toBeLessThanOrEqual(
      J_BATCH_CONTRACT_LIMITS.maxDisputeStarterArgumentsBytes,
    );
    expect(sanitizeOptionalDisputeArgument(maximumSide, 'dispute.max-side')).toEqual({
      value: maximumSide,
      warnings: [],
    });

    // Splitting the same maximum Account state across both makers adds a second
    // bytes[] wrapper, so it is the aggregate-cap boundary the pair sanitizer
    // must preserve without erasing either side's honest evidence.
    const left = encodeArguments(Math.ceil(maxOffers / 2), maxSecrets, 2);
    const right = encodeArguments(Math.floor(maxOffers / 2), 0, 2);
    expect(encodedBytes(left)).toBeLessThanOrEqual(
      J_BATCH_CONTRACT_LIMITS.maxDisputeStarterArgumentsBytes,
    );
    expect(encodedBytes(right)).toBeLessThanOrEqual(
      J_BATCH_CONTRACT_LIMITS.maxDisputeStarterArgumentsBytes,
    );
    const sanitizedPair = sanitizeOptionalDisputeStarterArgumentPair(left, right, 'dispute.max-account');
    expect(sanitizedPair).toEqual({ initial: left, counter: right, warnings: [] });
    expect(sanitizedPair.initial).not.toBe('0x');
    expect(sanitizedPair.counter).not.toBe('0x');
  });

  test('builds positional swap args from frozen AccountState', () => {
    const account = accountWithSwaps([
      ['z-right-owned', offer('z-right-owned', false, 2, 1)],
      ['a-left-owned', offer('a-left-owned', true, 1, 2)],
    ]);
    account.mempool = [
      { type: 'swap_resolve', data: { offerId: 'a-left-owned', fillRatio: 111, cancelRemainder: false } },
      { type: 'swap_resolve', data: { offerId: 'z-right-owned', fillRatio: 222, cancelRemainder: false } },
      { type: 'swap_resolve', data: { offerId: 'unrelated', fillRatio: 333, cancelRemainder: false } },
    ];
    const args = buildDisputeArgumentsFromState(account, { secretsSide: 'left' }, []);

    expect(decodeFirstRatio(args.leftArguments)).toBe(222);
    expect(decodeFirstRatio(args.rightArguments)).toBe(111);
  });

  test('aligns one argument tuple with both canonical payment and swap clauses', () => {
    const account = accountWithSwaps([
      ['right-owned', offer('right-owned', false, 2, 1)],
    ]);
    account.state.locks.set('lock', {
      lockId: 'lock',
      hashlock: `0x${'ab'.repeat(32)}`,
      timelock: 100_000n,
      amount: 1n,
      tokenId: 1,
      senderIsLeft: true,
      createdHeight: 1,
      createdTimestamp: 1,
    });
    const plan = buildCurrentDisputeArgumentPlan(account);
    expect(plan.paymentHashlocks).toHaveLength(1);
    expect(plan.leftSwapOfferIds.length + plan.rightSwapOfferIds.length).toBe(1);
    account.mempool = [{
      type: 'swap_resolve',
      data: { offerId: 'right-owned', fillRatio: 32_768, cancelRemainder: false },
    }];
    const secret = `0x${'cd'.repeat(32)}`;
    const built = buildDisputeArgumentsFromState(
      account,
      { secretsSide: 'left' },
      [secret],
    );
    const [clauses] = ethers.AbiCoder.defaultAbiCoder().decode(
      ['bytes[]'],
      built.leftArguments,
    ) as unknown as [string[]];
    expect(clauses).toHaveLength(2);
    expect(clauses[0]).toBe(clauses[1]);
    const [decoded] = ethers.AbiCoder.defaultAbiCoder().decode(
      ['tuple(uint16[] fillRatios, bytes32[] secrets)'],
      clauses[1]!,
    ) as unknown as [{ fillRatios: bigint[]; secrets: string[] }];
    expect(Array.from(decoded.fillRatios, Number)).toEqual([32_768]);
    expect(decoded.secrets).toEqual([secret]);
  });

  test('uses a late Account mempool fill omitted from the optimistic pending frame', () => {
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
      accountTxs: [{ type: 'direct_payment', data: { tokenId: 1, amount: 1n } }],
      prevFrameHash: 'after-first',
      stateHash: 'pending-second',
      byLeft: false,
      deltas: [],
    };
    account.mempool = [{
      type: 'swap_resolve',
      data: { offerId: 'remaining-left-owned', fillRatio: 32_768, cancelRemainder: false },
    }];
    const args = buildDisputeArgumentsFromState(
      account,
      { secretsSide: 'left' },
      [],
    );
    expect(decodeFirstRatio(args.rightArguments)).toBe(32768);
    account.mempool = [];
    const withoutIntent = buildDisputeArgumentsFromState(
      account,
      { secretsSide: 'left' },
      [],
    );
    expect(withoutIntent.rightArguments).toBe('0x');
  });

  test('isolates invalid or unplanned Account mempool evidence per signed offer', () => {
    const account = accountWithSwaps([
      ['invalid', offer('invalid', true, 1, 2)],
      ['valid', offer('valid', true, 1, 2)],
    ]);
    account.mempool = [
      { type: 'swap_resolve', data: { offerId: 'invalid', fillRatio: 65_536, cancelRemainder: false } },
      { type: 'swap_resolve', data: { offerId: 'valid', fillRatio: 32_768, cancelRemainder: false } },
      { type: 'swap_resolve', data: { offerId: 'unplanned', fillRatio: 12_345, cancelRemainder: false } },
    ];
    const args = buildDisputeArgumentsFromState(
      account,
      { secretsSide: 'left' },
      [],
    );
    const abi = ethers.AbiCoder.defaultAbiCoder();
    const [wrapped] = abi.decode(['bytes[]'], args.rightArguments) as unknown as [string[]];
    const [decoded] = abi.decode(
      ['tuple(uint16[] fillRatios, bytes32[] secrets)'],
      wrapped[0]!,
    ) as unknown as [{ fillRatios: bigint[] }];
    expect(Array.from(decoded.fillRatios, Number)).toEqual([0, 32_768]);
  });

  test('ignores malformed optional HTLC and cross-pull evidence', () => {
    const account = accountWithSwaps([]);
    account.state.locks.set('lock', {
      lockId: 'lock',
      hashlock: `0x${'ab'.repeat(32)}`,
      timelock: 100_000n,
      amount: 1n,
      tokenId: 1,
      senderIsLeft: true,
      createdHeight: 1,
      createdTimestamp: 1,
    });
    account.state.pulls.set('pull', {
      pullId: 'pull',
      tokenId: 1,
      amount: 1n,
      fullHash: `0x${'cd'.repeat(32)}`,
      partialRoot: `0x${'ef'.repeat(32)}`,
      crossJurisdiction: {
        orderId: 'order', routeHash: `0x${'12'.repeat(32)}`, leg: 'source', status: 'resting',
      },
      createdHeight: 1,
      createdTimestamp: 1,
    });
    const closeProof = {
      orderId: 'order', routeHash: `0x${'12'.repeat(32)}`,
      sourcePullId: 'pull', targetPullId: 'target', fillRatio: 1,
      cumulativeSourceAmount: 1n, cumulativeTargetAmount: 1n,
      binaryHash: `0x${'34'.repeat(32)}`, closeMode: 'partial_cancel_remainder' as const,
    };
    account.mempool = [
      { type: 'cross_pull_close', data: { pullId: 'pull', binary: '0x1234', proof: closeProof } },
      { type: 'cross_pull_close', data: { pullId: 'pull', binary: '0x5678', proof: closeProof } },
    ];

    const args = buildDisputeArgumentsFromState(account, { secretsSide: 'left' }, []);
    expect(args.leftArguments).toBe('0x');
  });
});
