import { sha512 } from '@noble/hashes/sha2.js';
import type { RuntimeReplica, RuntimeTx } from '../runtime/types';
import { importEntity } from '../runtime/registration/entity-creation';
import { deriveEntityEncryptionPrivateKey } from '../runtime/registration/entity-creation/crypto';
import { provisionEntityEncryptionKey } from '../entity/auth/crypto';

type ImportReplicaTx = Extract<RuntimeTx, { type: 'importReplica' }>;

const testEntitySeed = (entityId: string): Uint8Array =>
  sha512(new TextEncoder().encode(`xln:test-entity-custody:${entityId.toLowerCase()}`));

export const provisionTestEntityEncryptionKey = (
  env: RuntimeReplica,
  entityId: string,
): Readonly<{ publicKey: string; privateKey: string }> => {
  const seed = testEntitySeed(entityId);
  const privateKey = deriveEntityEncryptionPrivateKey(seed, entityId);
  env.infrastructure ??= {};
  env.infrastructure.entityEncryptionSeeds ??= new Map();
  env.infrastructure.entityEncryptionSeeds.set(entityId.toLowerCase(), `0x${Buffer.from(seed).toString('hex')}`);
  return { privateKey, publicKey: provisionEntityEncryptionKey(env, entityId, privateKey) };
};

/** Deterministic test/scenario custody; production modules must never import this file. */
export const createTestEntityImportRuntimeTx = (
  _env: RuntimeReplica,
  input: Readonly<{
    entityId: string;
    signerId: string;
    data: Omit<ImportReplicaTx['data'], 'entitySeed'>;
  }>,
): ImportReplicaTx => {
  return importEntity({
    ...input,
    entitySeed: testEntitySeed(input.entityId),
  });
};
