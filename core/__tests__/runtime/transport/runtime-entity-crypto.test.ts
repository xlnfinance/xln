import { describe, expect, test } from 'bun:test';

import { deriveSignerAddressSync } from '../../../account/crypto';
import {
  assertLocalEntityCryptoKeys,
  requireEntityEncryptionPrivateKey,
} from '../../../entity/auth/crypto';
import { createEmptyEnv, generateLazyEntityId } from '../../../runtime';
import { applyRuntimeTx } from '../../../runtime/tx/tx-handlers';
import { createTestEntityImportRuntimeTx } from '../../../qa/entity-creation-fixture';

const jurisdiction = {
  address: `0x${'22'.repeat(20)}`, name: 'Testnet', chainId: 31337,
  entityProviderAddress: `0x${'22'.repeat(20)}`,
  depositoryAddress: `0x${'11'.repeat(20)}`,
};

const installJurisdiction = (env: ReturnType<typeof createEmptyEnv>): void => {
  env.activeJurisdiction = jurisdiction.name;
  env.state.jReplicas.set(jurisdiction.name, {
    name: jurisdiction.name, blockNumber: 0n, stateRoot: new Uint8Array(32), mempool: [],
    blockDelayMs: 0, lastBlockTimestamp: 0, position: { x: 0, y: 0, z: 0 },
    contracts: { depository: jurisdiction.depositoryAddress, entityProvider: jurisdiction.entityProviderAddress },
    chainId: jurisdiction.chainId,
  });
};

describe('runtime entity crypto', () => {
  test('import replay derives the same entity-wide key and stores no private key in state', async () => {
    const env = createEmptyEnv('runtime-entity-crypto-import');
    installJurisdiction(env);
    const signerId = deriveSignerAddressSync('runtime-entity-crypto-import', '1').toLowerCase();
    const entityId = generateLazyEntityId([signerId], 1n).toLowerCase();
    const tx = createTestEntityImportRuntimeTx(env, {
      entityId, signerId,
      data: {
        isProposer: true,
        config: { mode: 'proposer-based', threshold: 1n, validators: [signerId], shares: { [signerId]: 1n }, jurisdiction },
      },
    });

    await applyRuntimeTx(env, tx);
    const replica = env.state.eReplicas.get(`${entityId}:${signerId}`)!;
    expect(requireEntityEncryptionPrivateKey(env, entityId)).toMatch(/^0x[0-9a-f]{64}$/);
    expect(replica.state.entityEncryptionPublicKey).toMatch(/^0x[0-9a-f]{64}$/);
    expect(Object.hasOwn(replica.state, 'entityEncryptionPrivateKey')).toBeFalse();
    expect(() => assertLocalEntityCryptoKeys(env)).not.toThrow();
  });

  test('state/public-key corruption is rejected against the replay-derived secret', async () => {
    const env = createEmptyEnv('runtime-entity-crypto-corruption');
    installJurisdiction(env);
    const signerId = deriveSignerAddressSync('runtime-entity-crypto-corruption', '1').toLowerCase();
    const entityId = generateLazyEntityId([signerId], 1n).toLowerCase();
    await applyRuntimeTx(env, createTestEntityImportRuntimeTx(env, {
      entityId, signerId,
      data: {
        isProposer: true,
        config: { mode: 'proposer-based', threshold: 1n, validators: [signerId], shares: { [signerId]: 1n }, jurisdiction },
      },
    }));
    env.state.eReplicas.get(`${entityId}:${signerId}`)!.state.entityEncryptionPublicKey = `0x${'11'.repeat(32)}`;
    expect(() => assertLocalEntityCryptoKeys(env)).toThrow('ENTITY_CRYPTO_KEY_MISMATCH');
  });
});
