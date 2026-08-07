import { describe, expect, test } from 'bun:test';

import { createEmptyEnv } from '../runtime';
import { queueHashLadderRevealRegistration } from '../entity/tx/j-events-htlc';
import type { CrossJurisdictionSwapRoute } from '../types/cross-jurisdiction';
import {
  addReplica,
  addr,
  entity,
  makeJurisdiction,
  makeState,
  registerTestSigner,
} from './helpers/cross-j';

const pull = {
  fullHash: `0x${'11'.repeat(32)}`,
  partialRoot: `0x${'22'.repeat(32)}`,
};

const reveal = (fillRatio: number) => ({
  fillRatio,
  fullSecret: `0x${'00'.repeat(32)}`,
  reveals: [
    `0x${'33'.repeat(32)}`,
    `0x${'44'.repeat(32)}`,
    `0x${'55'.repeat(32)}`,
    `0x${'66'.repeat(32)}`,
  ] as [string, string, string, string],
});

describe('hash-ladder reveal queue (exact-once / single-shot)', () => {
  test('queues the first write and refuses a higher-ratio replace on the same ladder', () => {
    const env = createEmptyEnv('reveal-queue-exact-once');
    env.scenarioMode = true;
    const eth = makeJurisdiction('Ethereum', 1, '11', '12');
    const user = entity('61');
    const hub = entity('62');
    const signer = registerTestSigner(env, 'reveal-queue-exact-once', 'hub');
    const state = makeState(hub, signer, eth, user);
    addReplica(env, state, signer);

    expect(queueHashLadderRevealRegistration(state, pull, reveal(0x1000))).toBe('queued');
    expect(state.jBatchState?.batch.hashLadderReveals).toHaveLength(1);
    expect(state.jBatchState?.batch.hashLadderReveals[0]?.fillRatio).toBe(0x1000);

    // Old max-ratio policy would splice to 0x2000 and later E12 the whole batch.
    expect(queueHashLadderRevealRegistration(state, pull, reveal(0x2000))).toBe('already-queued');
    expect(state.jBatchState?.batch.hashLadderReveals).toHaveLength(1);
    expect(state.jBatchState?.batch.hashLadderReveals[0]?.fillRatio).toBe(0x1000);
  });

  test('same-ratio retry stays already-queued (idempotent)', () => {
    const env = createEmptyEnv('reveal-queue-same-ratio');
    env.scenarioMode = true;
    const eth = makeJurisdiction('Ethereum', 1, '11', '12');
    const user = entity('71');
    const hub = entity('72');
    const signer = registerTestSigner(env, 'reveal-queue-same-ratio', 'hub');
    const state = makeState(hub, signer, eth, user);

    expect(queueHashLadderRevealRegistration(state, pull, reveal(0x0123))).toBe('queued');
    expect(queueHashLadderRevealRegistration(state, pull, reveal(0x0123))).toBe('already-queued');
    expect(state.jBatchState?.batch.hashLadderReveals).toHaveLength(1);
  });

  test('does not re-queue after registryFillRatio latches on the route', () => {
    const env = createEmptyEnv('reveal-queue-registry-latch');
    env.scenarioMode = true;
    const eth = makeJurisdiction('Ethereum', 1, '11', '12');
    const user = entity('81');
    const hub = entity('82');
    const signer = addr('91');
    const state = makeState(hub, signer, eth, user);
    const route: CrossJurisdictionSwapRoute = {
      orderId: 'latch-route',
      makerEntityId: user,
      hubEntityId: hub,
      source: {
        jurisdiction: 'eth',
        entityId: user,
        counterpartyEntityId: hub,
        tokenId: 1,
        amount: 100n,
      },
      target: {
        jurisdiction: 'base',
        entityId: entity('83'),
        counterpartyEntityId: entity('84'),
        tokenId: 1,
        amount: 90n,
      },
      sourcePull: {
        pullId: 'source-pull',
        tokenId: 1,
        amount: 100n,
        signedAmount: 100n,
        fullHash: pull.fullHash,
        partialRoot: pull.partialRoot,
      },
      // On-chain registration already observed — must not enqueue again.
      registryFillRatio: 0x1000,
      status: 'resting',
      createdAt: 1,
      updatedAt: 1,
    };
    state.crossJurisdictionSwaps = new Map([[route.orderId, route]]);

    expect(queueHashLadderRevealRegistration(state, pull, reveal(0x2000))).toBe('already-queued');
    expect(state.jBatchState?.batch.hashLadderReveals ?? []).toHaveLength(0);
  });

  test('own-slot latch blocks queue; foreign-looking claimedRatio alone does not', () => {
    // claimedRatio may track a hub reveal we observed; registryFillRatio is the
    // own-slot latch. Confusing them is the silent target-leg-zero bug.
    const env = createEmptyEnv('reveal-queue-foreign-vs-own');
    env.scenarioMode = true;
    const eth = makeJurisdiction('Ethereum', 1, '11', '12');
    const user = entity('91');
    const hub = entity('92');
    const signer = addr('93');
    const state = makeState(user, signer, eth, hub);
    const route: CrossJurisdictionSwapRoute = {
      orderId: 'foreign-vs-own',
      makerEntityId: user,
      hubEntityId: hub,
      source: {
        jurisdiction: 'eth',
        entityId: user,
        counterpartyEntityId: hub,
        tokenId: 1,
        amount: 100n,
      },
      target: {
        jurisdiction: 'base',
        entityId: entity('94'),
        counterpartyEntityId: user,
        tokenId: 1,
        amount: 90n,
      },
      sourcePull: {
        pullId: 'source-pull',
        tokenId: 1,
        amount: 100n,
        signedAmount: 100n,
        fullHash: pull.fullHash,
        partialRoot: pull.partialRoot,
      },
      targetPull: {
        pullId: 'target-pull',
        tokenId: 1,
        amount: 90n,
        signedAmount: -90n,
        fullHash: pull.fullHash,
        partialRoot: pull.partialRoot,
      },
      claimedRatio: 0x1000,
      status: 'resting',
      createdAt: 1,
      updatedAt: 1,
    };
    state.crossJurisdictionSwaps = new Map([[route.orderId, route]]);

    expect(queueHashLadderRevealRegistration(state, pull, reveal(0x1000))).toBe('queued');
    expect(state.jBatchState?.batch.hashLadderReveals).toHaveLength(1);

    route.registryFillRatio = 0x1000;
    state.jBatchState!.batch.hashLadderReveals = [];
    expect(queueHashLadderRevealRegistration(state, pull, reveal(0x1000))).toBe('already-queued');
  });
});
