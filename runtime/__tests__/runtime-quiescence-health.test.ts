import { expect, test } from 'bun:test';

import { createEmptyEnv } from '../runtime';
import {
  hasPairMutualCredit,
  isAccountWriteLaneIdle,
  summarizeRuntimeQuiescence,
} from '../orchestrator/mesh-common';
import type { AccountMachine, DeliverableEntityInput, EntityReplica } from '../types';

test('bootstrap quiescence counts only reliable outbox and live Account work', () => {
  const env = createEmptyEnv('runtime-quiescence-health deterministic seed');
  const reliable = {
    runtimeId: `0x${'11'.repeat(20)}`,
    entityId: `0x${'22'.repeat(32)}`,
    signerId: `0x${'33'.repeat(20)}`,
    proposedFrame: {
      height: 2,
      timestamp: 2,
      hash: `0x${'44'.repeat(32)}`,
      txs: [],
      leader: { proposerSignerId: `0x${'33'.repeat(20)}`, view: 0 },
      collectedSigs: new Map(),
    },
  } satisfies DeliverableEntityInput;
  env.pendingNetworkOutputs = [reliable, {
    runtimeId: `0x${'55'.repeat(20)}`,
    entityId: `0x${'66'.repeat(32)}`,
    signerId: `0x${'77'.repeat(20)}`,
    entityTxs: [],
  }];
  env.eReplicas = new Map([['fixture', {
    state: {
      accounts: new Map([
        ['a', { pendingFrame: { height: 3 }, mempool: [{ type: 'chat' }, { type: 'chat' }] }],
        ['b', { mempool: [{ type: 'chat' }] }],
      ]),
    },
  } as unknown as EntityReplica]]);

  expect(summarizeRuntimeQuiescence(env)).toEqual({
    pendingRuntimeWork: 1,
    pendingReliableOutputs: 1,
    pendingAccountFrames: 1,
    accountMempoolTxs: 3,
  });
});

test('committed credit stays usable while an offline peer leaves durable Account work pending', () => {
  const env = createEmptyEnv('runtime-account-readiness deterministic seed');
  const leftEntity = `0x${'11'.repeat(32)}`;
  const rightEntity = `0x${'22'.repeat(32)}`;
  const account = {
    status: 'active',
    leftEntity,
    rightEntity,
    currentHeight: 7,
    currentFrame: { height: 7 },
    pendingFrame: { height: 8 },
    mempool: [{ type: 'chat', data: { message: 'durable until peer returns' } }],
    deltas: new Map([[1, { leftCreditLimit: 100n, rightCreditLimit: 100n }]]),
  } as unknown as AccountMachine;
  env.eReplicas = new Map([[`${leftEntity}:1`, {
    entityId: leftEntity,
    signerId: '1',
    state: { entityId: leftEntity, accounts: new Map([[rightEntity, account]]) },
  } as unknown as EntityReplica]]);

  expect(hasPairMutualCredit(env, leftEntity, rightEntity, 1, 100n)).toBe(true);
  expect(isAccountWriteLaneIdle(account)).toBe(false);
});
