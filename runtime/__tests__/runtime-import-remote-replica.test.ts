import { describe, expect, test } from 'bun:test';

import { createEmptyEnv, enqueueRuntimeInput, process } from '../runtime';
import type { JReplica, JurisdictionConfig } from '../types';

const addr = (byte: string): string => `0x${byte.repeat(20)}`;

const installJurisdiction = (env: ReturnType<typeof createEmptyEnv>): JurisdictionConfig => {
  const jurisdiction: JurisdictionConfig = {
    name: 'RemoteTestnet',
    address: 'rpc://remote-testnet',
    chainId: 31337,
    depositoryAddress: addr('11'),
    entityProviderAddress: addr('12'),
  };
  env.activeJurisdiction = jurisdiction.name;
  env.jReplicas.set(jurisdiction.name, {
    name: jurisdiction.name,
    rpcs: [jurisdiction.address],
    chainId: jurisdiction.chainId,
    depositoryAddress: jurisdiction.depositoryAddress,
    entityProviderAddress: jurisdiction.entityProviderAddress,
    contracts: {
      depository: jurisdiction.depositoryAddress,
      entityProvider: jurisdiction.entityProviderAddress,
      account: addr('13'),
      deltaTransformer: addr('14'),
    },
  } as JReplica);
  return jurisdiction;
};

describe('runtime remote replica import', () => {
  test('imports remote replica without requiring local signer key or local gossip announce', async () => {
    const namespace = `runtime-import-remote-replica-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const env = createEmptyEnv(namespace);
    env.dbNamespace = namespace;
    env.quietRuntimeLogs = true;
    const jurisdiction = installJurisdiction(env);

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
            jurisdiction,
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
