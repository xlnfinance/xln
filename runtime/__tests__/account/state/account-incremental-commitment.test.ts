import { describe, expect, test } from 'bun:test';

import {
  commitStagedAccountCommitmentCache,
  invalidateAccountMapCommitment,
  stageAccountCommitmentCache,
} from '../../../account/commitment/map-commitment';
import {
  computeAccountStateRoot,
  computeAccountStateRootCold,
} from '../../../account/commitment/state-root';
import { cloneAccountReplica } from '../../../account/state/state-clone';
import { createEntityFrameCandidateState } from '../../../entity/state-clone';
import type { SwapOffer } from '../../../types/account';
import type { EntityState } from '../../../entity/types';
import { createDefaultDelta } from '../../../account/state/delta';
import { makeAccount } from '../../helpers/cross-j';

const LEFT = `0x${'11'.repeat(32)}`;
const RIGHT = `0x${'22'.repeat(32)}`;

const offer = (index: number): SwapOffer => ({
  offerId: `offer-${index.toString().padStart(5, '0')}`,
  giveTokenId: 2,
  giveAmount: 1_000_000n + BigInt(index),
  wantTokenId: 1,
  wantAmount: 2_000_000n + BigInt(index),
  maxFee: 0n,
  minNetReceive: 2_000_000n + BigInt(index),
  priceTicks: 2_000_000n,
  timeInForce: 0,
  makerIsLeft: true,
  createdHeight: index + 1,
  quantizedGive: 1_000_000n + BigInt(index),
  quantizedWant: 2_000_000n + BigInt(index),
});

const account = (offerCount: number) => {
  const replica = makeAccount(LEFT, RIGHT);
  replica.state.swapOffers = new Map(Array.from({ length: offerCount }, (_, index) => {
    const value = offer(index);
    return [value.offerId, value];
  }));
  return replica;
};

const measured = (operation: () => string): { value: string; durationMs: number } => {
  const startedAt = performance.now();
  const value = operation();
  return { value, durationMs: performance.now() - startedAt };
};

describe('incremental Account commitment', () => {
  test('updates one leaf in a 10k-offer account and matches a cold rebuild', () => {
    const base = account(10_000);
    base.state.deltas = new Map(Array.from({ length: 10_000 }, (_, tokenId) => {
      const delta = createDefaultDelta(tokenId);
      delta.offdelta = BigInt(tokenId);
      return [tokenId, delta];
    }));
    const cold = measured(() => computeAccountStateRoot(base.state));
    const cached = measured(() => computeAccountStateRoot(base.state));
    expect(cached.value).toBe(cold.value);

    const changed = cloneAccountReplica(base);
    const changedOffer = changed.state.swapOffers.get('offer-05000')!;
    changedOffer.giveAmount += 1n;
    changed.state.deltas.get(2)!.offdelta += 1n;
    invalidateAccountMapCommitment(changed.state, 'swapOffers', changedOffer.offerId);
    invalidateAccountMapCommitment(changed.state, 'deltas', 2);

    const incremental = measured(() => computeAccountStateRoot(changed.state));
    const oracle = measured(() => computeAccountStateRootCold(changed.state));
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
    const warmRoot = computeAccountStateRoot(base.state);
    const state = {
      entityId: LEFT,
      height: 0,
      timestamp: 0,
      nonces: new Map(),
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

    const cloned = createEntityFrameCandidateState(state);
    const clonedAccount = cloned.accounts.get(RIGHT)!;
    const changedOffer = clonedAccount.state.swapOffers.get('offer-05000')!;
    changedOffer.giveAmount += 1n;
    invalidateAccountMapCommitment(clonedAccount.state, 'swapOffers', changedOffer.offerId);

    const incremental = measured(() => computeAccountStateRoot(clonedAccount.state));
    const oracle = measured(() => computeAccountStateRootCold(clonedAccount.state));
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
    computeAccountStateRoot(base.state);

    const proposed = cloneAccountReplica(base);
    proposed.state.swapOffers.get('offer-05000')!.giveAmount += 1n;
    invalidateAccountMapCommitment(proposed.state, 'swapOffers', 'offer-05000');
    const expectedRoot = computeAccountStateRoot(proposed.state);
    stageAccountCommitmentCache(base.state, proposed.state);

    const state = {
      entityId: LEFT,
      height: 0,
      timestamp: 0,
      nonces: new Map(),
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
    const afterRuntimeBoundary = createEntityFrameCandidateState(state).accounts.get(RIGHT)!;

    // ACK re-executes the certified tx on the real state before promoting the
    // staged future cache. Mirror that deterministic transition here.
    afterRuntimeBoundary.state.swapOffers.get('offer-05000')!.giveAmount += 1n;
    invalidateAccountMapCommitment(afterRuntimeBoundary.state, 'swapOffers', 'offer-05000');
    commitStagedAccountCommitmentCache(afterRuntimeBoundary.state);

    const committed = measured(() => computeAccountStateRoot(afterRuntimeBoundary.state));
    expect(committed.value).toBe(expectedRoot);
    expect(committed.durationMs).toBeLessThan(10);
    console.log(JSON.stringify({
      kind: 'ACCOUNT_COMMITMENT_STAGED_ACK_BENCH',
      offers: 10_000,
      committedMs: Number(committed.durationMs.toFixed(3)),
    }));
  });
});
