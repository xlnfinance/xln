import { expect, test } from 'bun:test';
import { resolveRuntimeAdapterRead } from '../../../api/runtime-adapter/resolve';
import type { RuntimeAdapterEntitySummary } from '../../../api/runtime-adapter/types';
import { createEmptyEnv } from '../../../runtime';
import { createEntityProposalFixture } from '../../helpers/entity-proposal-fixture';

test('explicit peer lookup rejects malformed and unavailable profiles without inventing a role', async () => {
  const env = createEmptyEnv('peer profile boundary');
  await expect(resolveRuntimeAdapterRead({ env }, 'entities', { entityId: 'unknown' })).rejects.toThrow(
    'entity profile lookup requires a 32-byte entity id',
  );
  await expect(resolveRuntimeAdapterRead({ env }, 'entities', { entityId: `0x${'12'.repeat(32)}` })).rejects.toThrow(
    'entity profile is unavailable',
  );
  expect(await resolveRuntimeAdapterRead({ env }, 'entities')).toEqual([]);
});

test('committed local role does not require a network profile; historical lookup stays offline', async () => {
  const fixture = createEntityProposalFixture('local profile lookup', 1n, ['1']);
  const { env, replica, signerId } = fixture.createValidator('1');
  env.state.height = 1;
  env.state.eReplicas.set(`${fixture.entityId}:${signerId}`, replica);
  const current = await resolveRuntimeAdapterRead<RuntimeAdapterEntitySummary[]>({ env }, 'entities', {
    entityId: fixture.entityId,
  });
  expect(current).toHaveLength(1);
  expect(current[0]).toMatchObject({ entityId: fixture.entityId, signerId, isHub: false });
  const historical = await resolveRuntimeAdapterRead({ env }, 'entities', {
    entityId: `0x${'13'.repeat(32)}`,
    atHeight: 1,
  });
  expect(historical).toEqual(current);
});
