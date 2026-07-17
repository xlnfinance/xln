import { describe, expect, test } from 'bun:test';

import { applyRuntimeTx } from '../machine/tx-handlers';
import {
  hasPendingCommittedJBatch,
  registerPendingCommittedJOutbox,
} from '../machine/j-submit-state';
import { collectDueJSubmitRuntimeTxs } from '../machine/j-submit-scheduler';
import { buildCanonicalEntityReplicaSnapshot } from '../wal/snapshot';
import {
  makeJSubmitDurabilityFixture,
  batchHash,
  entityId,
  jurisdictionName,
  signerId,
} from './fixtures/j-submit-durability-fixture';

const secondEntityId = `0x${'32'.repeat(32)}`;

const addSecondEntityWithSameBatch = (fixture: ReturnType<typeof makeJSubmitDurabilityFixture>) => {
  const second = buildCanonicalEntityReplicaSnapshot(fixture.replica);
  second.entityId = secondEntityId;
  second.state.entityId = secondEntityId;
  // This is an independent entity lane. Cloning the fixture must not also
  // clone entity A's validator-local retry clock into entity B.
  delete second.jSubmitState;
  fixture.env.eReplicas.set(`${secondEntityId}:${signerId}`, second);
  return second;
};

describe('J-submit lane identity', () => {
  test('durable pending attempt for entity A does not block entity B with the same batch hash and nonce', async () => {
    const fixture = makeJSubmitDurabilityFixture();
    const [firstRetry] = collectDueJSubmitRuntimeTxs(fixture.env, fixture.env.timestamp);
    if (!firstRetry) throw new Error('first entity retry missing');
    const firstOutbox = await applyRuntimeTx(fixture.env, firstRetry, { isReplay: true });
    registerPendingCommittedJOutbox(fixture.env, firstOutbox);
    addSecondEntityWithSameBatch(fixture);

    const retries = collectDueJSubmitRuntimeTxs(fixture.env, fixture.env.timestamp);
    expect(retries).toHaveLength(1);
    expect(retries[0]?.data.entityId).toBe(secondEntityId);
  });

  test('queued retry for entity A does not globally deduplicate entity B lane', () => {
    const fixture = makeJSubmitDurabilityFixture();
    addSecondEntityWithSameBatch(fixture);
    const retries = collectDueJSubmitRuntimeTxs(fixture.env, fixture.env.timestamp);
    const firstRetry = retries.find((retry) => retry.data.entityId !== secondEntityId);
    if (!firstRetry) throw new Error('first queued entity retry missing');
    fixture.env.runtimeMempool = {
      runtimeTxs: [firstRetry],
      entityInputs: [],
    };

    const dueWithFirstQueued = collectDueJSubmitRuntimeTxs(fixture.env, fixture.env.timestamp);
    expect(dueWithFirstQueued).toHaveLength(1);
    expect(dueWithFirstQueued[0]?.data.entityId).toBe(secondEntityId);
  });

  test('pending identity is scoped by jurisdiction and validator signer', async () => {
    const fixture = makeJSubmitDurabilityFixture();
    const [firstRetry] = collectDueJSubmitRuntimeTxs(fixture.env, fixture.env.timestamp);
    if (!firstRetry) throw new Error('first signer retry missing');
    const firstOutbox = await applyRuntimeTx(fixture.env, firstRetry, { isReplay: true });
    registerPendingCommittedJOutbox(fixture.env, firstOutbox);
    const generation = firstRetry.data.batchGeneration;
    expect(hasPendingCommittedJBatch(fixture.env, {
      jurisdictionName: `${jurisdictionName}-other`,
      entityId,
      signerId,
      entityNonce: 1,
      batchHash,
      batchGeneration: generation,
    })).toBe(false);
    expect(hasPendingCommittedJBatch(fixture.env, {
      jurisdictionName,
      entityId,
      signerId: `0x${'42'.repeat(20)}`,
      entityNonce: 1,
      batchHash,
      batchGeneration: generation,
    })).toBe(false);
  });
});
