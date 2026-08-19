import { describe, expect, test } from 'bun:test';
import { PersistentAccountStateMap } from '../../../account/state/persistent-state-map';
import { computeAccountStateRoot, computeAccountStateRootCold } from '../../../account/commitment/state-root';
import { forkAccountReplicaShell } from '../../../account/state/account-replica-shell';
import { createEntityFrameCandidateState } from '../../../entity/state-clone';
import {
  EntityAccountCandidateMap,
  PersistentEntityAccountMap,
} from '../../../entity/state/persistent-account-map';
import { PersistentEntityCollectionMap } from '../../../entity/state/persistent-collection-map';
import { computeEntityAccountValueHash } from '../../../entity/consensus/state-root';
import { safeStringify } from '../../../protocol/serialization';
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
  replica.state.swapOffers = PersistentAccountStateMap.fromEntries(
    'swapOffers',
    Array.from({ length: offerCount }, (_, index) => {
      const value = offer(index);
      return [value.offerId, value] as const;
    }),
  );
  replica.state.deltas = PersistentAccountStateMap.fromEntries(
    'deltas',
    Array.from({ length: offerCount }, (_, index) => {
      const tokenId = index + 1;
      const delta = createDefaultDelta(tokenId);
      delta.offdelta = BigInt(tokenId);
      return [tokenId, delta] as const;
    }),
  );
  return replica;
};

const bumpOffer = (replica: ReturnType<typeof makeAccount>, offerId: string) => {
  const previous = replica.state.swapOffers.get(offerId);
  if (!previous) throw new Error(`ACCOUNT_COMMITMENT_OFFER_MISSING:${offerId}`);
  replica.state.swapOffers = replica.state.swapOffers.updated(offerId, {
    ...previous,
    giveAmount: previous.giveAmount + 1n,
  });
};

const accountForEntity = (offerCount: number) => {
  const replica = makeAccount(LEFT, RIGHT);
  replica.state.swapOffers = PersistentAccountStateMap.fromEntries(
    'swapOffers',
    Array.from({ length: offerCount }, (_, index) => {
      const value = offer(index);
      return [value.offerId, value] as const;
    }),
  );
  return replica;
};

const entityWithAccount = (replica: ReturnType<typeof makeAccount>): EntityState => ({
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
  accounts: PersistentEntityAccountMap.fromMap(
    new Map([[RIGHT, replica]]),
    LEFT,
    computeEntityAccountValueHash,
  ),
  lastFinalizedJHeight: 0,
  htlcRoutes: PersistentEntityCollectionMap.empty(),
  lockBook: PersistentEntityCollectionMap.empty(),
}) as EntityState;

const writableEntityAccount = (
  state: EntityState,
): ReturnType<typeof makeAccount> => {
  if (!(state.accounts instanceof EntityAccountCandidateMap)) {
    throw new Error('ACCOUNT_COMMITMENT_ENTITY_ACCOUNTS_NOT_CANDIDATE');
  }
  const replica = state.accounts.getForWrite(RIGHT);
  if (!replica) throw new Error('ACCOUNT_COMMITMENT_ENTITY_ACCOUNT_MISSING');
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
    const cold = measured(() => computeAccountStateRoot(base.state));
    const cached = measured(() => computeAccountStateRoot(base.state));
    expect(cached.value).toBe(cold.value);

    const changed = forkAccountReplicaShell(base);
    bumpOffer(changed, 'offer-05000');
    const previousDelta = changed.state.deltas.get(2);
    if (!previousDelta) throw new Error('ACCOUNT_COMMITMENT_DELTA_MISSING:2');
    changed.state.deltas = changed.state.deltas.updated(2, {
      ...previousDelta,
      offdelta: previousDelta.offdelta + 1n,
    });

    const incremental = measured(() => computeAccountStateRoot(changed.state));
    const oracle = measured(() => computeAccountStateRootCold(changed.state));
    expect(incremental.value).not.toBe(cold.value);
    expect(incremental.value).toBe(oracle.value);
    expect(incremental.durationMs).toBeLessThan(cold.durationMs);
    expect(cached.durationMs).toBeLessThan(cold.durationMs);
    expect(computeAccountStateRoot(base.state)).toBe(cold.value);

    console.log(safeStringify({
      kind: 'ACCOUNT_COMMITMENT_BENCH',
      offers: 10_000,
      deltas: 10_000,
      coldMs: Number(cold.durationMs.toFixed(3)),
      cachedMs: Number(cached.durationMs.toFixed(3)),
      oneLeafMs: Number(incremental.durationMs.toFixed(3)),
      oracleMs: Number(oracle.durationMs.toFixed(3)),
    }));
  });

  test('in-place scalar mutation misses the colocated Account root memo', () => {
    const replica = account(2);
    const first = computeAccountStateRoot(replica.state);
    replica.state.jNonce += 1;
    const second = computeAccountStateRoot(replica.state);
    expect(second).not.toBe(first);
    expect(second).toBe(computeAccountStateRootCold(replica.state));
    const third = computeAccountStateRoot(replica.state);
    expect(third).toBe(second);
  });

  test('preserves the warm commitment through the Entity overlay boundary', () => {
    const base = accountForEntity(10_000);
    const warmRoot = computeAccountStateRoot(base.state);
    const cloned = createEntityFrameCandidateState(entityWithAccount(base));
    const clonedAccount = writableEntityAccount(cloned);
    bumpOffer(clonedAccount, 'offer-05000');

    const incremental = measured(() => computeAccountStateRoot(clonedAccount.state));
    const oracle = measured(() => computeAccountStateRootCold(clonedAccount.state));
    expect(incremental.value).not.toBe(warmRoot);
    expect(incremental.value).toBe(oracle.value);
    expect(incremental.durationMs).toBeLessThan(oracle.durationMs);
    expect(computeAccountStateRoot(base.state)).toBe(warmRoot);

    console.log(safeStringify({
      kind: 'ACCOUNT_COMMITMENT_ENTITY_CLONE_BENCH',
      offers: 10_000,
      oneLeafMs: Number(incremental.durationMs.toFixed(3)),
      oracleMs: Number(oracle.durationMs.toFixed(3)),
    }));
  });

  test('proposed overlay hash stays off live until publish', () => {
    const base = accountForEntity(10_000);
    computeAccountStateRoot(base.state);

    const proposed = forkAccountReplicaShell(base);
    bumpOffer(proposed, 'offer-05000');
    const expectedRoot = computeAccountStateRoot(proposed.state);
    expect(computeAccountStateRoot(base.state)).not.toBe(expectedRoot);

    const afterRuntimeBoundary = writableEntityAccount(
      createEntityFrameCandidateState(entityWithAccount(base)),
    );
    expect(computeAccountStateRoot(afterRuntimeBoundary.state)).not.toBe(expectedRoot);

    bumpOffer(afterRuntimeBoundary, 'offer-05000');
    const committed = measured(() => computeAccountStateRoot(afterRuntimeBoundary.state));
    expect(committed.value).toBe(expectedRoot);
    expect(committed.durationMs).toBeLessThan(10);
    console.log(safeStringify({
      kind: 'ACCOUNT_COMMITMENT_STAGED_ACK_BENCH',
      offers: 10_000,
      committedMs: Number(committed.durationMs.toFixed(3)),
    }));
  });
});
