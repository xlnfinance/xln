import { describe, expect, test } from 'bun:test';
import { createEmptyEnv } from '../../../runtime';
import { importEntity } from '../../../runtime/registration/entity-creation';
import { generateLazyEntityId } from '../../../entity/factory';
import { deriveMnemonicCustodySeed } from '../../../runtime/registration/entity-creation/mnemonic-seed';
import { applyRuntimeTx } from '../../../runtime/transactions/tx-handlers';
import { deserializeTaggedJson, serializeTaggedJson } from '../../../protocol/serialization';
import { validateRuntimeTx } from '../../../runtime/input-schema/runtime-tx';
import { restoreEntityKeysFromAuthoritativeSnapshot } from '../../../storage/recovery/load';
import { requireEntityEncryptionPrivateKey } from '../../../entity/auth/crypto';
import {
  buildDurableRuntimeMachineSnapshot,
  restoreDurableRuntimeSnapshot,
} from '../../../storage/wal/snapshot';

const SIGNER_ID = `0x${'34'.repeat(20)}`;
const CONFIG = {
  mode: 'proposer-based' as const,
  threshold: 1n,
  validators: [SIGNER_ID],
  shares: { [SIGNER_ID]: 1n },
  jurisdiction: {
    address: `0x${'a1'.repeat(20)}`,
    name: 'EntityCreationBoundary',
    chainId: 31_337,
    depositoryAddress: `0x${'a2'.repeat(20)}`,
    entityProviderAddress: `0x${'a3'.repeat(20)}`,
  },
};
const ENTITY_ID = generateLazyEntityId([SIGNER_ID], 1n);
const installJurisdiction = (env: ReturnType<typeof createEmptyEnv>): void => {
  env.state.jReplicas.set('EntityCreationBoundary', {
    name: 'EntityCreationBoundary', blockNumber: 0n, stateRoot: null, mempool: [],
    blockDelayMs: 0, lastBlockTimestamp: 0, chainId: 31_337,
    position: { x: 0, y: 0, z: 0 },
    depositoryAddress: `0x${'a2'.repeat(20)}`,
    entityProviderAddress: `0x${'a3'.repeat(20)}`,
    contracts: { depository: `0x${'a2'.repeat(20)}`, entityProvider: `0x${'a3'.repeat(20)}` },
  });
};

describe('Entity creation custody boundary', () => {
  test('matches the official BIP-39 seed vector and canonicalizes phrase whitespace', () => {
    const phrase = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
    const expected = '5eb00bbddcf069084889a8ab9155568165f5c453ccb85e70811aaed6f6da5fc19a5ac40b389cd370d086206dec8aa6c43daea6690f20ad3d8d48b2d2ce9e38e4';
    expect(Buffer.from(deriveMnemonicCustodySeed(phrase)).toString('hex')).toBe(expected);
    expect(deriveMnemonicCustodySeed(`  ${phrase.replaceAll(' ', '  ')}\n`))
      .toEqual(deriveMnemonicCustodySeed(phrase));
    expect(() => deriveMnemonicCustodySeed('not a valid bip39 phrase'))
      .toThrow();
  });

  test('rejects every non-canonical import seed representation', () => {
    const tx = importEntity({
      entityId: ENTITY_ID, signerId: SIGNER_ID,
      entitySeed: new Uint8Array(64).fill(10),
      data: { config: CONFIG, isProposer: true },
    });
    expect(validateRuntimeTx(tx, 'IMPORT')).toEqual(tx);
    expect(() => validateRuntimeTx({ ...tx, data: { ...tx.data, entitySeed: tx.data.entitySeed.toUpperCase() } }, 'IMPORT'))
      .toThrow('IMPORT_DATA_ENTITY_SEED_CANONICAL');
    expect(() => validateRuntimeTx({ ...tx, data: { ...tx.data, entitySeed: '0x01' } }, 'IMPORT'))
      .toThrow('IMPORT_DATA_ENTITY_SEED_CANONICAL');
  });

  test('commits the canonical seed and deterministically provisions replay infrastructure', async () => {
    const left = createEmptyEnv('entity-creation-left');
    const right = createEmptyEnv('entity-creation-right');
    installJurisdiction(left);
    installJurisdiction(right);
    const build = () => importEntity({
      entityId: ENTITY_ID,
      signerId: SIGNER_ID,
      entitySeed: new Uint8Array(64).fill(7),
      data: { config: CONFIG, isProposer: true },
    });
    const leftTx = build();
    const rightTx = deserializeTaggedJson(serializeTaggedJson(leftTx)) as typeof leftTx;
    await applyRuntimeTx(left, leftTx);
    await applyRuntimeTx(right, rightTx);
    expect(leftTx.data.entitySeed).toBe(`0x${'07'.repeat(64)}`);
    expect(left.state.eReplicas.get(`${ENTITY_ID}:${SIGNER_ID}`)?.state.entityEncryptionPublicKey)
      .toBe(right.state.eReplicas.get(`${ENTITY_ID}:${SIGNER_ID}`)?.state.entityEncryptionPublicKey);
    expect(left.infrastructure?.entityEncryptionPrivateKeys?.has(ENTITY_ID)).toBe(true);
  });

  test('a conflicting replay cannot overwrite an installed Entity secret', async () => {
    const env = createEmptyEnv('entity-creation-conflict');
    installJurisdiction(env);
    const original = importEntity({
      entityId: ENTITY_ID,
      signerId: SIGNER_ID,
      entitySeed: new Uint8Array(64).fill(1),
      data: { config: CONFIG, isProposer: true },
    });
    await applyRuntimeTx(env, original);
    const originalPrivateKey = env.infrastructure?.entityEncryptionPrivateKeys?.get(ENTITY_ID);
    const conflict = importEntity({
      entityId: ENTITY_ID,
      signerId: SIGNER_ID,
      entitySeed: new Uint8Array(64).fill(2),
      data: { config: CONFIG, isProposer: true },
    });
    await expect(applyRuntimeTx(env, conflict)).rejects.toThrow();
    expect(env.infrastructure?.entityEncryptionPrivateKeys?.get(ENTITY_ID)).toBe(originalPrivateKey);
    await applyRuntimeTx(env, importEntity({
      entityId: ENTITY_ID,
      signerId: SIGNER_ID,
      entitySeed: new Uint8Array(64).fill(1),
      data: { config: CONFIG, isProposer: true },
    }));
    expect(env.infrastructure?.entityEncryptionPrivateKeys?.get(ENTITY_ID)).toBe(originalPrivateKey);
  });

  test('rejects lazy IDs, signers, and proposer roles not authorized by the board', async () => {
    const env = createEmptyEnv('entity-creation-board-authority');
    installJurisdiction(env);
    const base = importEntity({
      entityId: ENTITY_ID, signerId: SIGNER_ID,
      entitySeed: new Uint8Array(64).fill(4),
      data: { config: CONFIG, isProposer: true },
    });
    await expect(applyRuntimeTx(env, { ...base, entityId: `0x${'99'.repeat(32)}` }))
      .rejects.toThrow('IMPORT_REPLICA_LAZY_BOARD_ID_MISMATCH');
    await expect(applyRuntimeTx(env, { ...base, signerId: `0x${'55'.repeat(20)}` }))
      .rejects.toThrow('IMPORT_REPLICA_SIGNER_NOT_ON_BOARD');
    await expect(applyRuntimeTx(env, { ...base, data: { ...base.data, isProposer: false } }))
      .rejects.toThrow('IMPORT_REPLICA_PROPOSER_FLAG_INVALID');
  });

  test('sibling validators share one imported seed while retaining distinct proposer roles', async () => {
    const env = createEmptyEnv('entity-creation-siblings');
    installJurisdiction(env);
    const second = `0x${'56'.repeat(20)}`;
    const config = { ...CONFIG, validators: [SIGNER_ID, second], shares: { [SIGNER_ID]: 1n, [second]: 1n } };
    const entityId = generateLazyEntityId(config.validators, 1n);
    const seed = new Uint8Array(64).fill(8);
    await applyRuntimeTx(env, importEntity({ entityId, signerId: SIGNER_ID, entitySeed: seed, data: { config, isProposer: true } }));
    await applyRuntimeTx(env, importEntity({ entityId, signerId: second, entitySeed: seed, data: { config, isProposer: false } }));
    const publicKeys = [...env.state.eReplicas.values()].map(replica => replica.state.entityEncryptionPublicKey);
    expect(new Set(publicKeys).size).toBe(1);
    await expect(applyRuntimeTx(env, importEntity({
      entityId, signerId: second, entitySeed: new Uint8Array(64).fill(9), data: { config, isProposer: false },
    }))).rejects.toThrow();
  });

  test('reconstructs the Entity key directly from the authoritative snapshot seed map', () => {
    const env = createEmptyEnv('entity-creation-wal-recovery');
    installJurisdiction(env);
    env.infrastructure ??= {};
    env.infrastructure.entityEncryptionSeeds = new Map([
      [ENTITY_ID, `0x${'0c'.repeat(64)}`],
    ]);
    restoreEntityKeysFromAuthoritativeSnapshot(env);
    expect(requireEntityEncryptionPrivateKey(env, ENTITY_ID)).toMatch(/^0x[0-9a-f]{64}$/);
  });

  test('restores from a checkpoint after the original import WAL frame was pruned', async () => {
    const source = createEmptyEnv('entity-creation-pruned-import');
    installJurisdiction(source);
    await applyRuntimeTx(source, importEntity({
      entityId: ENTITY_ID, signerId: SIGNER_ID,
      entitySeed: new Uint8Array(64).fill(13), data: { config: CONFIG, isProposer: true },
    }));
    const checkpoint = buildDurableRuntimeMachineSnapshot(source);
    expect((checkpoint.infrastructure as { entityEncryptionSeeds?: Map<string, string> })
      .entityEncryptionSeeds?.get(ENTITY_ID)).toBe(`0x${'0d'.repeat(64)}`);

    const restored = createEmptyEnv('entity-creation-pruned-import');
    restoreDurableRuntimeSnapshot(restored, checkpoint);
    restoreEntityKeysFromAuthoritativeSnapshot(restored);
    expect(requireEntityEncryptionPrivateKey(restored, ENTITY_ID))
      .toBe(requireEntityEncryptionPrivateKey(source, ENTITY_ID));
  });
});
