import { describe, expect, test } from 'bun:test';

import { createEmptyEnv, enqueueRuntimeInput, process, submitDebtEnforcement } from '../runtime';
import type { JAdapter } from '../jadapter/types';
import { canonicalizeProfile, parseProfile } from '../networking/gossip';
import type { ConsensusConfig, Env, JReplica, JurisdictionConfig } from '../types';

const addr = (byte: string): string => `0x${byte.repeat(20)}`;
const entity = (byte: string): string => `0x${byte.repeat(32)}`;

const makeJurisdiction = (name: string, chainId: number, depByte: string, epByte: string): JurisdictionConfig => ({
  name,
  address: `rpc://${name}`,
  chainId,
  depositoryAddress: addr(depByte),
  entityProviderAddress: addr(epByte),
});

const installJurisdiction = (env: Env, jurisdiction: JurisdictionConfig, jadapter?: Partial<JAdapter>): void => {
  const adapter = jadapter
    ? {
        setBlockTimestamp: () => {},
        ...jadapter,
      } as Partial<JAdapter> & { setBlockTimestamp: () => void }
    : undefined;
  env.jReplicas.set(jurisdiction.name, {
    name: jurisdiction.name,
    rpcs: [jurisdiction.address],
    chainId: jurisdiction.chainId,
    depositoryAddress: jurisdiction.depositoryAddress,
    entityProviderAddress: jurisdiction.entityProviderAddress,
    contracts: {
      depository: jurisdiction.depositoryAddress,
      entityProvider: jurisdiction.entityProviderAddress,
      account: addr('aa'),
      deltaTransformer: addr('bb'),
    },
    ...(adapter ? { jadapter: adapter as JAdapter } : {}),
  } as JReplica);
};

const makeConfig = (signerId: string, jurisdiction: JurisdictionConfig): ConsensusConfig => ({
  mode: 'proposer-based',
  threshold: 1n,
  validators: [signerId],
  shares: { [signerId]: 1n },
  jurisdiction,
});

const makeEnv = (label: string): Env => {
  const unique = `${label}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const env = createEmptyEnv(unique);
  env.dbNamespace = unique;
  env.quietRuntimeLogs = true;
  return env;
};

describe('multi-jurisdiction entity binding', () => {
  test('rejects importing the same entity into a second jurisdiction', async () => {
    const env = makeEnv('multi-jurisdiction-conflict');
    const j1 = makeJurisdiction('J1', 31337, '11', '12');
    const j2 = makeJurisdiction('J2', 31338, '21', '22');
    installJurisdiction(env, j1);
    installJurisdiction(env, j2);
    env.activeJurisdiction = 'J1';

    const entityId = entity('01');
    const signerId = addr('31');
    enqueueRuntimeInput(env, {
      runtimeTxs: [{
        type: 'importReplica',
        entityId,
        signerId,
        data: {
          isProposer: true,
          config: makeConfig(signerId, j1),
        },
      }],
      entityInputs: [],
    });
    await process(env);

    enqueueRuntimeInput(env, {
      runtimeTxs: [{
        type: 'importReplica',
        entityId,
        signerId,
        data: {
          isProposer: true,
          config: makeConfig(signerId, j2),
        },
      }],
      entityInputs: [],
    });
    await expect(process(env)).rejects.toThrow('ENTITY_JURISDICTION_CONFLICT');
  });

  test('debt enforcement uses the entity jurisdiction instead of active jurisdiction', async () => {
    const env = makeEnv('multi-jurisdiction-debt');
    const j1 = makeJurisdiction('J1', 31337, '11', '12');
    const j2 = makeJurisdiction('J2', 31338, '21', '22');
    let j1Calls = 0;
    let j2Calls = 0;

    installJurisdiction(env, j1, {
      enforceDebts: async () => {
        j1Calls += 1;
      },
    });
    installJurisdiction(env, j2, {
      enforceDebts: async () => {
        j2Calls += 1;
      },
    });
    env.activeJurisdiction = 'J1';

    const entityId = entity('02');
    const signerId = addr('32');
    enqueueRuntimeInput(env, {
      runtimeTxs: [{
        type: 'importReplica',
        entityId,
        signerId,
        data: {
          isProposer: true,
          config: makeConfig(signerId, j2),
        },
      }],
      entityInputs: [],
    });
    await process(env);

    await submitDebtEnforcement(env, entityId, 1, 10n, signerId);

    expect(j1Calls).toBe(0);
    expect(j2Calls).toBe(1);
  });

  test('gossip profile metadata carries jurisdiction mirrors under the profile signature envelope', () => {
    const parsed = parseProfile({
      entityId: entity('03'),
      name: 'Alice Base',
      avatar: '',
      bio: '',
      website: '',
      lastUpdated: 1,
      runtimeId: addr('41'),
      runtimeEncPubKey: `0x${'42'.repeat(32)}`,
      publicAccounts: [],
      wsUrl: null,
      relays: [],
      metadata: {
        entityEncPubKey: `0x${'43'.repeat(32)}`,
        isHub: false,
        routingFeePPM: 1,
        baseFee: 0n,
        jurisdiction: {
          name: 'Base',
          chainId: 8453,
          entityProviderAddress: addr('44'),
          depositoryAddress: addr('45'),
        },
        mirrors: [{
          entityId: entity('04'),
          jurisdiction: {
            name: 'Ethereum',
            chainId: 1,
            entityProviderAddress: addr('46'),
            depositoryAddress: addr('47'),
          },
        }],
        board: {
          threshold: 1,
          validators: [{
            signer: addr('48'),
            signerId: addr('48'),
            weight: 1,
            publicKey: `0x${'49'.repeat(32)}`,
          }],
        },
      },
      accounts: [],
    });

    const canonical = canonicalizeProfile(parsed);

    expect(canonical.metadata.jurisdiction?.name).toBe('Base');
    expect(canonical.metadata.mirrors?.[0]?.entityId).toBe(entity('04'));
    expect(canonical.metadata.mirrors?.[0]?.jurisdiction.chainId).toBe(1);
  });
});
