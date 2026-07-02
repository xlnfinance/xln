import { describe, expect, test } from 'bun:test';

import { clearSignerKeys, deriveSignerAddressSync, deriveSignerKeySync, registerSignerKey } from '../account-crypto';
import { assertLocalEntityCryptoKeys, deriveLocalEntityCryptoKeys } from '../runtime-entity-crypto';
import { createEmptyEnv, generateLazyEntityId } from '../runtime';
import { applyRuntimeTx } from '../runtime-tx-handlers';

const testJurisdiction = {
  address: `0x${'22'.repeat(20)}`,
  name: 'Testnet',
  entityProviderAddress: `0x${'22'.repeat(20)}`,
  depositoryAddress: `0x${'11'.repeat(20)}`,
  chainId: 31337,
};

const testConfig = (signerId: string) => ({
  mode: 'proposer-based' as const,
  threshold: 1n,
  validators: [signerId],
  shares: { [signerId]: 1n },
  jurisdiction: testJurisdiction,
});

const addTestJurisdiction = (env: ReturnType<typeof createEmptyEnv>): void => {
  env.activeJurisdiction = testJurisdiction.name;
  env.jReplicas.set(testJurisdiction.name, {
    name: testJurisdiction.name,
    blockNumber: 0n,
    stateRoot: new Uint8Array(32),
    mempool: [],
    blockDelayMs: 0,
    lastBlockTimestamp: 0,
    position: { x: 0, y: 0, z: 0 },
    depositoryAddress: testJurisdiction.depositoryAddress,
    entityProviderAddress: testJurisdiction.entityProviderAddress,
    contracts: {
      account: `0x${'33'.repeat(20)}`,
      depository: testJurisdiction.depositoryAddress,
      entityProvider: testJurisdiction.entityProviderAddress,
      deltaTransformer: `0x${'44'.repeat(20)}`,
    },
    rpcs: ['http://localhost:8545'],
    chainId: testJurisdiction.chainId,
  });
};

describe('runtime entity crypto', () => {
  test('canonicalizes stale local encryption private keys when public key still matches', () => {
    clearSignerKeys();
    const seed = 'runtime-entity-crypto-canonical-local-private';
    const env = createEmptyEnv(seed);
    addTestJurisdiction(env);
    const signerId = deriveSignerAddressSync(seed, '1').toLowerCase();
    registerSignerKey(signerId, deriveSignerKeySync(seed, '1'));
    const entityId = generateLazyEntityId([signerId], 1n).toLowerCase();
    const keys = deriveLocalEntityCryptoKeys(env, entityId, signerId);

    env.eReplicas.set(`${entityId}:${signerId}`, {
      entityId,
      signerId,
      isProposer: true,
      mempool: [],
      state: {
        entityId,
        entityEncPubKey: keys.publicKey,
        entityEncPrivKey: `0x${'00'.repeat(32)}`,
      },
      hankoWitness: new Map(),
    } as any);

    assertLocalEntityCryptoKeys(env);

    const replica = env.eReplicas.get(`${entityId}:${signerId}`);
    expect(replica?.state.entityEncPubKey).toBe(keys.publicKey);
    expect(replica?.state.entityEncPrivKey).toBe(keys.privateKey);
  });

  test('rejects local replicas whose public encryption key belongs to another derivation', () => {
    clearSignerKeys();
    const seed = 'runtime-entity-crypto-reject-wrong-public';
    const env = createEmptyEnv(seed);
    const signerId = deriveSignerAddressSync(seed, '1').toLowerCase();
    registerSignerKey(signerId, deriveSignerKeySync(seed, '1'));
    const entityId = generateLazyEntityId([signerId], 1n).toLowerCase();

    env.eReplicas.set(`${entityId}:${signerId}`, {
      entityId,
      signerId,
      isProposer: true,
      mempool: [],
      state: {
        entityId,
        entityEncPubKey: `0x${'11'.repeat(32)}`,
        entityEncPrivKey: `0x${'22'.repeat(32)}`,
      },
      hankoWitness: new Map(),
    } as any);

    expect(() => assertLocalEntityCryptoKeys(env)).toThrow('ENTITY_CRYPTO_KEY_MISMATCH');
  });

  test('direct importReplica canonicalizes stale local private key when public key matches', async () => {
    clearSignerKeys();
    const seed = 'runtime-entity-crypto-import-replica-canonical-local-private';
    const env = createEmptyEnv(seed);
    addTestJurisdiction(env);
    const signerId = deriveSignerAddressSync(seed, '1').toLowerCase();
    registerSignerKey(signerId, deriveSignerKeySync(seed, '1'));
    const entityId = generateLazyEntityId([signerId], 1n).toLowerCase();
    const keys = deriveLocalEntityCryptoKeys(env, entityId, signerId);

    env.eReplicas.set(`${entityId}:${signerId}`, {
      entityId,
      signerId,
      isProposer: true,
      mempool: [],
      state: {
        entityId,
        entityEncPubKey: keys.publicKey,
        entityEncPrivKey: `0x${'00'.repeat(32)}`,
        config: testConfig(signerId),
        swapTradingPairs: [],
      },
      hankoWitness: new Map(),
    } as any);

    await applyRuntimeTx(env, {
      type: 'importReplica',
      entityId,
      signerId,
      data: {
        isProposer: true,
        config: testConfig(signerId),
      },
    });

    const replica = env.eReplicas.get(`${entityId}:${signerId}`);
    expect(replica?.state.entityEncPubKey).toBe(keys.publicKey);
    expect(replica?.state.entityEncPrivKey).toBe(keys.privateKey);
  });
});
