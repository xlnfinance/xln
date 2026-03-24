import { describe, expect, test } from 'bun:test';

import { createEmptyEnv, enqueueRuntimeInput, process } from '../runtime';

describe('runtime remote replica import', () => {
  test('imports remote replica without requiring local signer key or local gossip announce', async () => {
    const env = createEmptyEnv('runtime-import-remote-replica');
    env.quietRuntimeLogs = true;

    const signerId = `0x${'ab'.repeat(20)}`;
    const entityId = `0x${'cd'.repeat(32)}`;

    enqueueRuntimeInput(env, {
      runtimeTxs: [{
        type: 'importReplica',
        entityId,
        signerId,
        data: {
          config: {
            mode: 'proposer-based',
            threshold: 1n,
            validators: [signerId],
            shares: { [signerId]: 1n },
          },
          isProposer: false,
          profileName: 'Remote Hub',
        },
      }],
      entityInputs: [],
    });

    await process(env);

    const replica = env.eReplicas.get(`${entityId}:${signerId}`);
    expect(replica).toBeDefined();
    expect(replica?.state.entityEncPubKey).toBe('');
    expect(replica?.state.entityEncPrivKey).toBe('');
    expect(env.gossip.getProfiles().some(profile => profile.entityId === entityId)).toBe(false);
  });
});
