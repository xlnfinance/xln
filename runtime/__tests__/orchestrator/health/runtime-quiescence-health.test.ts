import { expect, test } from 'bun:test';

import { createEmptyEnv } from '../../../runtime';
import {
  hasPairMutualCredit,
  isAccountWriteLaneIdle,
  summarizeRuntimeQuiescence,
} from '../../../orchestrator/mesh/mesh-common';
import { buildEntityHashesToSign } from '../../../entity/consensus/input/hanko-witness';
import type { AccountReplica } from '../../../types/account';
import type { DeliverableEntityInput } from '../../../runtime/types';
import type { EntityReplica } from '../../../entity/types';

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
      hashesToSign: buildEntityHashesToSign(
        `0x${'22'.repeat(32)}`,
        2,
        `0x${'44'.repeat(32)}`,
      ),
      collectedSigs: new Map(),
    },
  } satisfies DeliverableEntityInput;
  env.pendingNetworkOutputs = [reliable, {
    runtimeId: `0x${'55'.repeat(20)}`,
    entityId: `0x${'66'.repeat(32)}`,
    signerId: `0x${'77'.repeat(20)}`,
    entityTxs: [],
  }];
  env.state.eReplicas = new Map([['fixture', {
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
    state: {
      leftEntity,
      rightEntity,
      deltas: new Map([[1, {
        tokenId: 1,
        leftCreditLimit: 100n,
        rightCreditLimit: 100n,
        collateral: 0n,
        ondelta: 0n,
        offdelta: 0n,
        leftAllowance: 0n,
        rightAllowance: 0n,
        leftHold: 0n,
        rightHold: 0n,
      }]]),
    },
    status: 'active',
    currentHeight: 7,
    currentFrame: { height: 7 },
    pendingFrame: { height: 8 },
    mempool: [{ type: 'chat', data: { message: 'durable until peer returns' } }],
  } as unknown as AccountReplica;
  env.state.eReplicas = new Map([[`${leftEntity}:1`, {
    entityId: leftEntity,
    signerId: '1',
    entityEncPubKey: '',
    state: { entityId: leftEntity, accounts: new Map([[rightEntity, account]]) },
  } as unknown as EntityReplica]]);

  expect(hasPairMutualCredit(env, leftEntity, rightEntity, 1, 100n)).toBe(true);
  expect(isAccountWriteLaneIdle(account)).toBe(false);
});
