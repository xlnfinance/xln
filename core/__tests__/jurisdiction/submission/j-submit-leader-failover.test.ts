import { describe, expect, test } from 'bun:test';

import { createEmptyEnv } from '../../../runtime';
import { applyRuntimeTx } from '../../../runtime/tx/tx-handlers';
import {
  makeJSubmitResultRuntimeTx,
  registerPendingCommittedJOutbox,
} from '../../../runtime/j-submit/j-submit-state';
import { collectDueJSubmitRuntimeTxs } from '../../../runtime/j-submit/j-submit-scheduler';
import {
  buildCanonicalEntityReplicaSnapshot,
  buildDurableRuntimeMachineSnapshot,
  restoreDurableRuntimeSnapshot,
} from '../../../storage/wal/snapshot';
import type { EntityReplica } from '../../../entity/types';
import {
  makeJSubmitDurabilityFixture,
  signerId as firstLeaderId,
} from '../../fixtures/j-submit/j-submit-durability-fixture';

const secondLeaderId = `0x${'42'.repeat(20)}`;

const requireBatchAttempt = (outbox: Awaited<ReturnType<typeof applyRuntimeTx>>) => {
  const batchTx = outbox[0]?.jTxs[0];
  if (!batchTx || batchTx.type !== 'batch' || !batchTx.data.runtimeSubmitAttempt) {
    throw new Error('leader failover J-submit attempt missing');
  }
  return batchTx;
};

const restoreFailoverEnv = (source: ReturnType<typeof createEmptyEnv>) => {
  const restored = createEmptyEnv('j-submit-leader-failover-restore');
  restoreDurableRuntimeSnapshot(restored, buildDurableRuntimeMachineSnapshot(source));
  restored.state.eReplicas = new Map(Array.from(source.state.eReplicas.entries()).map(([key, replica]) => [
    key,
    buildCanonicalEntityReplicaSnapshot(replica),
  ]));
  return restored;
};

describe('validator-local J submit leader failover', () => {
  test('new certified leader attempt #1 cannot collide with old leader attempt #1', async () => {
    const { env, replica: firstLeader } = makeJSubmitDurabilityFixture();
    const failoverConfig = {
      ...firstLeader.state.config,
      threshold: 2n,
      validators: [firstLeaderId, secondLeaderId],
      shares: { [firstLeaderId]: 1n, [secondLeaderId]: 1n },
    };
    firstLeader.state.config = failoverConfig;
    firstLeader.state.leaderState = {
      activeValidatorId: firstLeaderId,
      view: 0,
      changedAtHeight: firstLeader.state.height,
    };
    const secondLeader: EntityReplica = {
      ...buildCanonicalEntityReplicaSnapshot(firstLeader),
      signerId: secondLeaderId,
      isProposer: false,
      state: structuredClone(firstLeader.state),
    };
    delete secondLeader.jSubmitState;
    env.state.eReplicas = new Map([
      [`${firstLeader.entityId}:${firstLeaderId}`, firstLeader],
      [`${secondLeader.entityId}:${secondLeaderId}`, secondLeader],
    ]);
    env.runtimeId = firstLeaderId;

    const [firstRetry] = collectDueJSubmitRuntimeTxs(env, env.state.timestamp);
    if (!firstRetry) throw new Error('first leader retry missing');
    const firstOutbox = await applyRuntimeTx(env, firstRetry, { isReplay: true });
    registerPendingCommittedJOutbox(env, firstOutbox);
    const firstBatchTx = requireBatchAttempt(firstOutbox);
    const firstResult = makeJSubmitResultRuntimeTx(
      firstBatchTx,
      firstRetry.data.jurisdictionName,
      'terminalFailure',
      { message: 'old leader terminal' },
    );
    await applyRuntimeTx(env, firstResult, { isReplay: true });

    // This committed leaderState is the deterministic output of a separately
    // tested quorum-certified view change. Both replicas now agree that B is
    // authoritative, while validator-local submit attempt counters remain local.
    for (const replica of env.state.eReplicas.values()) {
      replica.state.leaderState = {
        activeValidatorId: secondLeaderId,
        view: 1,
        changedAtHeight: replica.state.height + 1,
      };
    }
    firstLeader.isProposer = false;
    secondLeader.isProposer = true;
    env.runtimeId = secondLeaderId;
    env.state.timestamp += 1;

    const [secondRetry] = collectDueJSubmitRuntimeTxs(env, env.state.timestamp);
    if (!secondRetry) throw new Error('second leader retry missing');
    const secondOutbox = await applyRuntimeTx(env, secondRetry, { isReplay: true });
    registerPendingCommittedJOutbox(env, secondOutbox);
    const secondBatchTx = requireBatchAttempt(secondOutbox);
    const firstAttemptId = firstBatchTx.data.runtimeSubmitAttempt!.attemptId;
    const secondAttemptId = secondBatchTx.data.runtimeSubmitAttempt!.attemptId;
    expect(firstBatchTx.data.runtimeSubmitAttempt?.attemptNumber).toBe(1);
    expect(secondBatchTx.data.runtimeSubmitAttempt?.attemptNumber).toBe(1);
    expect(secondAttemptId).not.toBe(firstAttemptId);

    const secondResult = makeJSubmitResultRuntimeTx(
      secondBatchTx,
      secondRetry.data.jurisdictionName,
      'submitted',
      { txHash: `0x${'ab'.repeat(32)}` },
    );
    await applyRuntimeTx(env, secondResult, { isReplay: true });
    expect(firstLeader.jSubmitState?.lastResultOutcome).toBe('terminalFailure');
    expect(secondLeader.jSubmitState?.lastResultOutcome).toBe('submitted');
    expect(env.infrastructure?.pendingCommittedJOutbox).toEqual([]);

    const restored = restoreFailoverEnv(env);
    const firstBeforeReplay = structuredClone(restored.state.eReplicas.get(
      `${firstLeader.entityId}:${firstLeaderId}`,
    )?.jSubmitState);
    const secondBeforeReplay = structuredClone(restored.state.eReplicas.get(
      `${secondLeader.entityId}:${secondLeaderId}`,
    )?.jSubmitState);
    await applyRuntimeTx(restored, structuredClone(firstResult), { isReplay: true });
    await applyRuntimeTx(restored, structuredClone(secondResult), { isReplay: true });
    expect(restored.state.eReplicas.get(`${firstLeader.entityId}:${firstLeaderId}`)?.jSubmitState)
      .toEqual(firstBeforeReplay);
    expect(restored.state.eReplicas.get(`${secondLeader.entityId}:${secondLeaderId}`)?.jSubmitState)
      .toEqual(secondBeforeReplay);
  });
});
