import { describe, expect, test } from 'bun:test';

import { createEmptyEnv, enqueueRuntimeInput, process, submitDebtEnforcement } from '../runtime';
import { applyEntityTx } from '../entity-tx/apply';
import { assertSameJurisdictionAccount } from '../jurisdiction-runtime';
import { deriveSignerAddressSync, deriveSignerKeySync, registerSignerKey } from '../account-crypto';
import { generateLazyEntityId } from '../entity-factory';
import { DEFAULT_ACCOUNT_TOKEN_IDS } from '../default-account-tokens';
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
  const importEntity = async (
    env: Env,
    entityId: string,
    signerId: string,
    jurisdiction: JurisdictionConfig,
  ): Promise<void> => {
    enqueueRuntimeInput(env, {
      runtimeTxs: [{
        type: 'importReplica',
        entityId,
        signerId,
        data: {
          isProposer: true,
          config: makeConfig(signerId, jurisdiction),
        },
      }],
      entityInputs: [],
    });
    await process(env);
  };

  const findState = (env: Env, entityId: string) =>
    Array.from(env.eReplicas.values()).find((replica) => replica.state.entityId === entityId)?.state;

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

  test('openAccount permits only same-jurisdiction counterparties', async () => {
    const env = makeEnv('multi-jurisdiction-open-ok');
    const j1 = makeJurisdiction('J1', 31337, '11', '12');
    installJurisdiction(env, j1);
    env.activeJurisdiction = 'J1';

    const entityA = entity('05');
    const entityB = entity('06');
    const signerA = '35';
    const signerB = '36';
    await importEntity(env, entityA, signerA, j1);
    await importEntity(env, entityB, signerB, j1);

    const result = await applyEntityTx(env, findState(env, entityA)!, {
      type: 'openAccount',
      data: { targetEntityId: entityB },
    });

    expect(result.newState.accounts.has(entityB.toLowerCase())).toBe(true);
  });

  test('openAccount seeds default token deltas and rebalance policies', async () => {
    const env = makeEnv('multi-jurisdiction-open-default-tokens');
    const j1 = makeJurisdiction('J1', 31337, '11', '12');
    installJurisdiction(env, j1);
    env.activeJurisdiction = 'J1';

    const entityA = entity('15');
    const entityB = entity('16');
    const signerA = '45';
    const signerB = '46';
    await importEntity(env, entityA, signerA, j1);
    await importEntity(env, entityB, signerB, j1);

    const result = await applyEntityTx(env, findState(env, entityA)!, {
      type: 'openAccount',
      data: { targetEntityId: entityB, tokenId: 1, creditAmount: 1_000n },
    });

    const account = result.newState.accounts.get(entityB.toLowerCase());
    expect(account).toBeTruthy();
    const expectedTokenIds = [...DEFAULT_ACCOUNT_TOKEN_IDS].sort((a, b) => a - b);
    const addDeltaTokenIds = account!.mempool
      .filter((tx) => tx.type === 'add_delta')
      .map((tx) => tx.data.tokenId)
      .sort((a, b) => a - b);
    const policyTokenIds = Array.from(account!.rebalancePolicy.keys()).sort((a, b) => a - b);
    const policyTxTokenIds = account!.mempool
      .filter((tx) => tx.type === 'set_rebalance_policy')
      .map((tx) => tx.data.tokenId)
      .sort((a, b) => a - b);

    expect(addDeltaTokenIds).toEqual(expectedTokenIds);
    expect(policyTokenIds).toEqual(expectedTokenIds);
    expect(policyTxTokenIds).toEqual(expectedTokenIds);
  });

  test('openAccount commits the first bilateral frame for local same-jurisdiction entities', async () => {
    const env = makeEnv('multi-jurisdiction-open-handshake');
    env.scenarioMode = true;
    const j1 = makeJurisdiction('J1', 31337, '11', '12');
    installJurisdiction(env, j1);
    env.activeJurisdiction = 'J1';

    const seed = `multi-jurisdiction-open-handshake-${Date.now()}`;
    const signerA = deriveSignerAddressSync(seed, '1');
    const signerB = deriveSignerAddressSync(seed, '2');
    registerSignerKey(signerA, deriveSignerKeySync(seed, '1'));
    registerSignerKey(signerB, deriveSignerKeySync(seed, '2'));
    const entityA = generateLazyEntityId([signerA], 1n).toLowerCase();
    const entityB = generateLazyEntityId([signerB], 1n).toLowerCase();
    await importEntity(env, entityA, signerA, j1);
    await importEntity(env, entityB, signerB, j1);

    enqueueRuntimeInput(env, {
      runtimeTxs: [],
      entityInputs: [{
        entityId: entityA,
        signerId: signerA,
        entityTxs: [{
          type: 'openAccount',
          data: { targetEntityId: entityB, tokenId: 1, creditAmount: 1_000n },
        }],
      }],
    });

    for (let i = 0; i < 6; i += 1) {
      await process(env);
      const accountA = findState(env, entityA)?.accounts.get(entityB);
      const accountB = findState(env, entityB)?.accounts.get(entityA);
      if (Number(accountA?.currentHeight ?? 0) > 0 && Number(accountB?.currentHeight ?? 0) > 0) break;
    }

    const accountA = findState(env, entityA)?.accounts.get(entityB);
    const accountB = findState(env, entityB)?.accounts.get(entityA);
    expect(accountA?.currentHeight).toBe(1);
    expect(accountB?.currentHeight).toBe(1);
    expect(accountA?.pendingFrame).toBeUndefined();
    expect(accountB?.pendingFrame).toBeUndefined();
  });

  test('openAccount rejects a local counterparty from another jurisdiction', async () => {
    const env = makeEnv('multi-jurisdiction-open-cross');
    const j1 = makeJurisdiction('J1', 31337, '11', '12');
    const j2 = makeJurisdiction('J2', 31338, '21', '22');
    installJurisdiction(env, j1);
    installJurisdiction(env, j2);

    const entityA = entity('07');
    const entityB = entity('08');
    const signerA = '37';
    const signerB = '38';
    await importEntity(env, entityA, signerA, j1);
    await importEntity(env, entityB, signerB, j2);

    expect(() =>
      assertSameJurisdictionAccount(env, entityA, findState(env, entityA)!.config.jurisdiction, entityB),
    ).toThrow('ACCOUNT_CROSS_JURISDICTION_FORBIDDEN');

    const result = await applyEntityTx(env, findState(env, entityA)!, {
      type: 'openAccount',
      data: { targetEntityId: entityB },
    });

    expect(result.newState.accounts.has(entityB.toLowerCase())).toBe(false);
  });

  test('account boundary fails closed when source jurisdiction is missing', () => {
    const env = makeEnv('multi-jurisdiction-source-missing');

    expect(() =>
      assertSameJurisdictionAccount(env, entity('0d'), null, entity('0e')),
    ).toThrow('ACCOUNT_SOURCE_JURISDICTION_UNKNOWN');
  });

  test('account boundary rejects same-chain metadata without depository binding', async () => {
    const env = makeEnv('multi-jurisdiction-chain-only');
    const j1 = makeJurisdiction('J1', 31337, '11', '12');
    installJurisdiction(env, j1);

    const entityA = entity('0f');
    const targetEntityId = entity('10');
    await importEntity(env, entityA, '42', j1);

    env.gossip.announce(parseProfile({
      entityId: targetEntityId,
      name: 'Stale chain-only target',
      avatar: '',
      bio: '',
      website: '',
      lastUpdated: 1,
      runtimeId: addr('50'),
      runtimeEncPubKey: `0x${'51'.repeat(32)}`,
      publicAccounts: [],
      wsUrl: null,
      relays: [],
      metadata: {
        entityEncPubKey: `0x${'52'.repeat(32)}`,
        isHub: false,
        routingFeePPM: 0,
        baseFee: 0n,
        jurisdiction: {
          name: 'J1 stale metadata',
          chainId: 31337,
          entityProviderAddress: addr('12'),
        } as never,
        board: {
          threshold: 1,
          validators: [{
            signer: addr('53'),
            signerId: addr('53'),
            weight: 1,
            publicKey: `0x${'54'.repeat(32)}`,
          }],
        },
      },
      accounts: [],
    }));

    expect(() =>
      assertSameJurisdictionAccount(env, entityA, findState(env, entityA)!.config.jurisdiction, targetEntityId),
    ).toThrow('ACCOUNT_CROSS_JURISDICTION_FORBIDDEN');

    const result = await applyEntityTx(env, findState(env, entityA)!, {
      type: 'openAccount',
      data: { targetEntityId },
    });

    expect(result.newState.accounts.has(targetEntityId.toLowerCase())).toBe(false);
  });

  test('accountInput cannot auto-create a cross-jurisdiction account', async () => {
    const env = makeEnv('multi-jurisdiction-account-input-cross');
    const j1 = makeJurisdiction('J1', 31337, '11', '12');
    const j2 = makeJurisdiction('J2', 31338, '21', '22');
    installJurisdiction(env, j1);
    installJurisdiction(env, j2);

    const entityA = entity('0b');
    const entityB = entity('0c');
    await importEntity(env, entityA, '40', j1);
    await importEntity(env, entityB, '41', j2);

    expect(() =>
      assertSameJurisdictionAccount(env, entityA, findState(env, entityA)!.config.jurisdiction, entityB),
    ).toThrow('ACCOUNT_CROSS_JURISDICTION_FORBIDDEN');

    const result = await applyEntityTx(env, findState(env, entityA)!, {
      type: 'accountInput',
      data: {
        kind: 'ack',
        fromEntityId: entityB,
        toEntityId: entityA,
        height: 0,
        prevHanko: '0x',
      },
    } as never);

    expect(result.newState.accounts.has(entityB.toLowerCase())).toBe(false);
  });

  test('openAccount rejects unknown jurisdiction for a bound entity', async () => {
    const env = makeEnv('multi-jurisdiction-open-unknown');
    const j1 = makeJurisdiction('J1', 31337, '11', '12');
    installJurisdiction(env, j1);

    const entityA = entity('09');
    const signerA = '39';
    await importEntity(env, entityA, signerA, j1);

    const targetEntityId = entity('0a');
    expect(() =>
      assertSameJurisdictionAccount(env, entityA, findState(env, entityA)!.config.jurisdiction, targetEntityId),
    ).toThrow('ACCOUNT_JURISDICTION_UNKNOWN');

    const result = await applyEntityTx(env, findState(env, entityA)!, {
      type: 'openAccount',
      data: { targetEntityId },
    });

    expect(result.newState.accounts.has(targetEntityId.toLowerCase())).toBe(false);
  });

  test('local counterparty without jurisdiction does not fall back to gossip metadata', async () => {
    const env = makeEnv('multi-jurisdiction-local-missing-fail-closed');
    const j1 = makeJurisdiction('J1', 31337, '11', '12');
    installJurisdiction(env, j1);

    const entityA = entity('13');
    const targetEntityId = entity('14');
    await importEntity(env, entityA, '55', j1);

    env.eReplicas.set(targetEntityId, {
      entityId: targetEntityId,
      signerId: '56',
      state: {
        entityId: targetEntityId,
        config: {
          mode: 'proposer-based',
          threshold: 1n,
          validators: ['56'],
          shares: { '56': 1n },
        },
      },
    } as never);

    env.gossip.announce(parseProfile({
      entityId: targetEntityId,
      name: 'Stale local target profile',
      avatar: '',
      bio: '',
      website: '',
      lastUpdated: 1,
      runtimeId: addr('57'),
      runtimeEncPubKey: `0x${'58'.repeat(32)}`,
      publicAccounts: [],
      wsUrl: null,
      relays: [],
      metadata: {
        entityEncPubKey: `0x${'59'.repeat(32)}`,
        isHub: false,
        routingFeePPM: 0,
        baseFee: 0n,
        jurisdiction: {
          name: j1.name,
          chainId: j1.chainId,
          entityProviderAddress: j1.entityProviderAddress,
          depositoryAddress: j1.depositoryAddress,
        },
        board: {
          threshold: 1,
          validators: [{
            signer: addr('5a'),
            signerId: addr('5a'),
            weight: 1,
            publicKey: `0x${'5b'.repeat(32)}`,
          }],
        },
      },
      accounts: [],
    }));

    expect(() =>
      assertSameJurisdictionAccount(env, entityA, findState(env, entityA)!.config.jurisdiction, targetEntityId),
    ).toThrow('ACCOUNT_JURISDICTION_UNKNOWN');
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
