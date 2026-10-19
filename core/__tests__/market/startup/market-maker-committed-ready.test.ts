import { expect, test } from 'bun:test';
import { createEntityProposalFixture } from '../../helpers/entity-proposal-fixture';
import { acquireRuntimeFrameWriter } from '../../../runtime/frame/lifecycle/writer-lock';
import { waitForReplicaReady } from '../../../orchestrator/market-maker/node/mm-node-core';

test('MM readiness waits for the writer publishing the Entity to commit', async () => {
  const fixture = createEntityProposalFixture('mm-committed-readiness', 1n, ['1']);
  const { env, replica, signerId } = fixture.createValidator('1');
  const infrastructure = env.infrastructure;
  if (!infrastructure) throw new Error('TEST_RUNTIME_INFRASTRUCTURE_MISSING');
  const release = await acquireRuntimeFrameWriter(infrastructure);
  infrastructure.stateMutationInFlight = true;
  env.state.eReplicas.set(`${fixture.entityId}:${signerId}`, replica);
  let ready = false;
  const pending = waitForReplicaReady(env, fixture.entityId).then(() => {
    ready = true;
  });
  try {
    await Bun.sleep(20);
    // A visible Entity is not committed authority while its frame owns the writer.
    expect(ready).toBeFalse();
  } finally {
    infrastructure.stateMutationInFlight = false;
    release();
    await pending;
  }
  expect(ready).toBeTrue();
});
