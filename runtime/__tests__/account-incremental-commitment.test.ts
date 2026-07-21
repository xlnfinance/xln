import { describe, expect, test } from 'bun:test';

import { createEmptyAccountJClaimAccumulator } from '../account/j-claim-accumulator';
import {
  commitStagedAccountCommitmentCache,
  invalidateAccountMapCommitment,
  stageAccountCommitmentCache,
} from '../account/map-commitment';
import {
  computeAccountStateRoot,
  computeAccountStateRootCold,
} from '../account/state-root';
import { cloneAccountMachine, cloneEntityState } from '../state-helpers';
import type { AccountMachine, EntityState, SwapOffer } from '../types';
import { createDefaultDelta } from '../validation-utils';

const LEFT = `0x${'11'.repeat(32)}`;
const RIGHT = `0x${'22'.repeat(32)}`;

const offer = (index: number): SwapOffer => ({
  offerId: `offer-${index.toString().padStart(5, '0')}`,
  giveTokenId: 2,
  giveAmount: 1_000_000n + BigInt(index),
  wantTokenId: 1,
  wantAmount: 2_000_000n + BigInt(index),
  priceTicks: 2_000_000n,
  timeInForce: 0,
  minFillRatio: 0,
  makerIsLeft: true,
  createdHeight: index + 1,
});

const account = (offerCount: number): AccountMachine => ({
  leftEntity: LEFT,
  rightEntity: RIGHT,
  domain: { chainId: 31337, depositoryAddress: `0x${'33'.repeat(20)}` },
  watchSeed: `0x${'44'.repeat(32)}`,
  status: 'active',
  mempool: [],
  currentFrame: {
    height: 0,
    timestamp: 0,
    jHeight: 0,
    accountTxs: [],
    prevFrameHash: `0x${'00'.repeat(32)}`,
    accountStateRoot: `0x${'00'.repeat(32)}`,
    stateHash: `0x${'00'.repeat(32)}`,
    deltas: [],
  },
  deltas: new Map(),
  locks: new Map(),
  pulls: new Map(),
  swapOffers: new Map(Array.from({ length: offerCount }, (_, index) => {
    const value = offer(index);
    return [value.offerId, value];
  })),
  globalCreditLimits: { ownLimit: 0n, peerLimit: 0n },
  currentHeight: 0,
  pendingSignatures: [],
  rollbackCount: 0,
  leftPendingJClaims: createEmptyAccountJClaimAccumulator(),
  rightPendingJClaims: createEmptyAccountJClaimAccumulator(),
  lastFinalizedJHeight: 0,
  proofHeader: { fromEntity: LEFT, toEntity: RIGHT, nextProofNonce: 1 },
  proofBody: { tokenIds: [], deltas: [] },
  disputeConfig: { leftDisputeDelay: 10, rightDisputeDelay: 10 },
  jNonce: 0,
  pendingWithdrawals: new Map(),
  requestedRebalance: new Map(),
  requestedRebalanceFeeState: new Map(),
  shadow: { rebalance: { policy: new Map(), submittedAtByToken: new Map() } },
});

const measured = (operation: () => string): { value: string; durationMs: number } => {
  const startedAt = performance.now();
  const value = operation();
  return { value, durationMs: performance.now() - startedAt };
};

describe('incremental Account commitment', () => {
  test('updates one leaf in a 10k-offer account and matches a cold rebuild', () => {
    const base = account(10_000);
    base.deltas = new Map(Array.from({ length: 10_000 }, (_, tokenId) => {
      const delta = createDefaultDelta(tokenId);
      delta.offdelta = BigInt(tokenId);
      return [tokenId, delta];
    }));
    const cold = measured(() => computeAccountStateRoot(base));
    const cached = measured(() => computeAccountStateRoot(base));
    expect(cached.value).toBe(cold.value);

    const changed = cloneAccountMachine(base);
    const changedOffer = changed.swapOffers.get('offer-05000')!;
    changedOffer.giveAmount += 1n;
    changed.deltas.get(2)!.offdelta += 1n;
    invalidateAccountMapCommitment(changed, 'swapOffers', changedOffer.offerId);
    invalidateAccountMapCommitment(changed, 'deltas', 2);

    const incremental = measured(() => computeAccountStateRoot(changed));
    const oracle = measured(() => computeAccountStateRootCold(changed));
    expect(incremental.value).not.toBe(cold.value);
    expect(incremental.value).toBe(oracle.value);
    expect(incremental.durationMs).toBeLessThan(cold.durationMs);
    expect(cached.durationMs).toBeLessThan(cold.durationMs);

    console.log(JSON.stringify({
      kind: 'ACCOUNT_COMMITMENT_BENCH',
      offers: 10_000,
      deltas: 10_000,
      coldMs: Number(cold.durationMs.toFixed(3)),
      cachedMs: Number(cached.durationMs.toFixed(3)),
      oneLeafMs: Number(incremental.durationMs.toFixed(3)),
      oracleMs: Number(oracle.durationMs.toFixed(3)),
    }));
  });

  test('preserves the warm commitment through the real Entity clone boundary', () => {
    const base = account(10_000);
    const warmRoot = computeAccountStateRoot(base);
    const state = {
      entityId: LEFT,
      height: 0,
      timestamp: 0,
      nonces: new Map(),
      messages: [],
      proposals: new Map(),
      config: {
        mode: 'proposer-based',
        threshold: 1n,
        validators: [LEFT],
        shares: { [LEFT]: 1n },
      },
      reserves: new Map(),
      accounts: new Map([[RIGHT, base]]),
      lastFinalizedJHeight: 0,
    } as EntityState;

    const cloned = cloneEntityState(state);
    const clonedAccount = cloned.accounts.get(RIGHT)!;
    const changedOffer = clonedAccount.swapOffers.get('offer-05000')!;
    changedOffer.giveAmount += 1n;
    invalidateAccountMapCommitment(clonedAccount, 'swapOffers', changedOffer.offerId);

    const incremental = measured(() => computeAccountStateRoot(clonedAccount));
    const oracle = measured(() => computeAccountStateRootCold(clonedAccount));
    expect(incremental.value).not.toBe(warmRoot);
    expect(incremental.value).toBe(oracle.value);
    expect(incremental.durationMs).toBeLessThan(oracle.durationMs);

    console.log(JSON.stringify({
      kind: 'ACCOUNT_COMMITMENT_ENTITY_CLONE_BENCH',
      offers: 10_000,
      oneLeafMs: Number(incremental.durationMs.toFixed(3)),
      oracleMs: Number(oracle.durationMs.toFixed(3)),
    }));
  });

  test('preserves a proposed future commitment until ACK across an Entity clone', () => {
    const base = account(10_000);
    computeAccountStateRoot(base);

    const proposed = cloneAccountMachine(base);
    proposed.swapOffers.get('offer-05000')!.giveAmount += 1n;
    invalidateAccountMapCommitment(proposed, 'swapOffers', 'offer-05000');
    const expectedRoot = computeAccountStateRoot(proposed);
    stageAccountCommitmentCache(base, proposed);

    const state = {
      entityId: LEFT,
      height: 0,
      timestamp: 0,
      nonces: new Map(),
      messages: [],
      proposals: new Map(),
      config: {
        mode: 'proposer-based',
        threshold: 1n,
        validators: [LEFT],
        shares: { [LEFT]: 1n },
      },
      reserves: new Map(),
      accounts: new Map([[RIGHT, base]]),
      lastFinalizedJHeight: 0,
    } as EntityState;
    const afterRuntimeBoundary = cloneEntityState(state).accounts.get(RIGHT)!;

    // ACK re-executes the certified tx on the real state before promoting the
    // staged future cache. Mirror that deterministic transition here.
    afterRuntimeBoundary.swapOffers.get('offer-05000')!.giveAmount += 1n;
    invalidateAccountMapCommitment(afterRuntimeBoundary, 'swapOffers', 'offer-05000');
    commitStagedAccountCommitmentCache(afterRuntimeBoundary);

    const committed = measured(() => computeAccountStateRoot(afterRuntimeBoundary));
    expect(committed.value).toBe(expectedRoot);
    expect(committed.durationMs).toBeLessThan(10);
    console.log(JSON.stringify({
      kind: 'ACCOUNT_COMMITMENT_STAGED_ACK_BENCH',
      offers: 10_000,
      committedMs: Number(committed.durationMs.toFixed(3)),
    }));
  });
});
