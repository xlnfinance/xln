import type { RuntimeTx } from '../../types';
import { sha512 } from '@noble/hashes/sha2.js';

type ImportReplicaTx = Extract<RuntimeTx, { type: 'importReplica' }>;
type ImportData = Omit<ImportReplicaTx['data'], 'entitySeed'>;

export const canonicalEntitySeed = (seed: Uint8Array | string): string => {
  if (typeof seed === 'string' && /^0x[0-9a-f]{128}$/i.test(seed)) return seed.toLowerCase();
  const bytes = typeof seed === 'string' ? sha512(new TextEncoder().encode(seed)) : seed;
  if (bytes.length !== 64) throw new Error('ENTITY_IMPORT_SEED_LENGTH');
  return `0x${Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')}`;
};

/**
 * Sole Entity import constructor. The seed is deliberately committed in the
 * Runtime transaction so apply and replay derive exactly the same Entity key.
 */
export const importEntity = (
  input: Readonly<{
    entityId: string;
    signerId: string;
    data: ImportData;
    entitySeed: Uint8Array | string;
  }>,
): ImportReplicaTx => {
  const entityId = input.entityId.trim().toLowerCase();
  return {
    type: 'importReplica',
    entityId,
    signerId: input.signerId.trim().toLowerCase(),
    data: { ...structuredClone(input.data), entitySeed: canonicalEntitySeed(input.entitySeed) },
  };
};
