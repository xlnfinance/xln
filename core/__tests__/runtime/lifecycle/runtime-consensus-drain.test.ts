import { expect, test } from 'bun:test';
import { clearSignerKeys } from '../../../account/crypto';
import { createEmptyEnv, hasRuntimeWork, waitForRuntimeWorkDrained } from '../../../runtime';
import { createEntityProposalFixture } from '../../helpers/entity-proposal-fixture';

test('drain times out while a real signed Entity proposal is waiting for quorum', async () => {
  const fixture = createEntityProposalFixture('runtime-consensus-drain');
  const { proposer, proposerReplica } = await fixture.buildHonestProposal();
  const { env, signerId } = proposer;
  env.state.eReplicas.set(`${fixture.entityId}:${signerId}`, proposerReplica);
  try {
    expect(proposerReplica.proposal).toBeDefined();
    // No immediately executable work does not mean remote consensus completed.
    expect(hasRuntimeWork(env)).toBe(false);
    expect(await waitForRuntimeWorkDrained(env, 40, 1)).toBe(false);
    expect(env.state.eReplicas.get(`${fixture.entityId}:${signerId}`)).toBe(proposerReplica);
    expect(proposerReplica.state.height).toBe(0);
  } finally {
    clearSignerKeys(env);
  }
});

test('an idle runtime without consensus work still drains', async () => {
  const env = createEmptyEnv(null);
  expect(await waitForRuntimeWorkDrained(env)).toBe(true);
});
