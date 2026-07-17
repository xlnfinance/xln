import { describe, expect, test } from 'bun:test';

import { createEmptyEnv, enqueueRuntimeInput, generateLazyEntityId, process } from '../runtime';
import { getJEventJurisdictionRef } from '../jurisdiction/event-observation';
import { EMPTY_J_HISTORY_ROOT } from '../jurisdiction/history-consensus';
import { hydrateEntityStateFromStorage, projectEntityCoreDoc } from '../storage/projections';
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
    // This fixture exercises a remote validator route, not an already
    // registered numbered Entity. Use the canonical lazy ID so lineage can
    // authenticate the genesis board without inventing registration evidence.
    const entityId = generateLazyEntityId([signerId], 1n).toLowerCase();
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
    expect(replica?.state.lastFinalizedJHeight).toBe(0);
    expect(env.gossip.getProfiles().some(profile => profile.entityId === entityId)).toBe(false);

    if (!replica) throw new Error('test replica missing after import');
    const jurisdictionRef = getJEventJurisdictionRef(jurisdiction);
    replica.state.jHistoryFinality = {
      jurisdictionRef,
      baseHeight: 0,
      finalizedThroughHeight: 0,
      tipBlockHash: `0x${'00'.repeat(32)}`,
      eventHistoryRoot: EMPTY_J_HISTORY_ROOT,
      proposerSignerId: signerId,
      proposerSignature: `0x${'66'.repeat(65)}`,
      entityHeight: 0,
    };
    const hydrated = hydrateEntityStateFromStorage({
      core: projectEntityCoreDoc(replica.state),
      accounts: new Map(),
      books: new Map(),
    });
    expect(hydrated.jHistoryFinality).toEqual(replica.state.jHistoryFinality);
  });

  test('failed same-frame import and Entity input restores exact pre-apply state', async () => {
    const env = createEmptyEnv('runtime-import-failure-atomicity');
    env.quietRuntimeLogs = true;
    env.scenarioMode = true;
    env.timestamp = 1_000;
    const jurisdiction = installJurisdiction(env);
    const signerId = `0x${'ab'.repeat(20)}`;
    const importedEntityId = generateLazyEntityId([signerId], 1n).toLowerCase();
    const unknownEntityId = generateLazyEntityId([`0x${'cd'.repeat(20)}`], 1n).toLowerCase();
    const runtimeInput = {
      runtimeTxs: [{
        type: 'importReplica' as const,
        entityId: importedEntityId,
        signerId,
        data: {
          config: {
            mode: 'proposer-based' as const,
            threshold: 1n,
            validators: [signerId],
            shares: { [signerId]: 1n },
            jurisdiction,
          },
          isProposer: false,
          profileName: 'Uncommitted import',
        },
      }],
      entityInputs: [{ entityId: unknownEntityId, signerId, entityTxs: [] }],
    };
    enqueueRuntimeInput(env, runtimeInput);

    await expect(process(env)).rejects.toThrow('RUNTIME_ENTITY_INPUT_UNKNOWN_TARGET');

    expect(env.eReplicas.has(`${importedEntityId}:${signerId}`)).toBe(false);
    expect([...env.eReplicas.values()].some(replica => replica.certifiedFrameAnchor !== undefined)).toBe(false);
    expect([...env.eReplicas.values()].some(replica => replica.certifiedFrameLineage !== undefined)).toBe(false);
    expect(env.height).toBe(0);
    expect(env.timestamp).toBe(1_000);
    expect(env.runtimeMempool?.runtimeTxs).toEqual(runtimeInput.runtimeTxs);
    expect(env.runtimeMempool?.entityInputs).toEqual(runtimeInput.entityInputs);
    expect(env.runtimeMempool?.queuedAt).toBe(1_000);
  });
});
