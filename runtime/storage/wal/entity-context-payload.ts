/**
 * Proposer infrastructure observations are replay inputs, not Runtime state.
 * Each exact context is stored once and WAL frames commit replica-id → hash
 * references. Recovery verifies the bytes before allowing deterministic replay.
 */
import type { EntityInfraContext } from '../../types/entity/infra-context';
import { validateEntityInfraContext } from '../../entity/consensus/frame/infra-context-validation';
import { computeIntegrityDigest } from '../../infra/integrity-checksum';
import { decodeValidatedBuffer, encodeBuffer } from '../codec/codec';
import { keyEntityContextPayload } from '../keys';
import type {
  EntityContextPayloadHash,
  RuntimeDbLike,
} from '../types';

export const MAX_ENTITY_CONTEXT_PAYLOAD_BYTES = 10_000;

const toEntityContextPayloadHash = (value: string): EntityContextPayloadHash => {
  if (!/^0x[0-9a-f]{64}$/.test(value)) {
    throw new Error(`STORAGE_ENTITY_CONTEXT_HASH_INVALID:${value}`);
  }
  return value as EntityContextPayloadHash;
};

const hashContext = (value: Uint8Array): EntityContextPayloadHash =>
  toEntityContextPayloadHash(computeIntegrityDigest(value).toLowerCase());

const assertReplicaId = (replicaId: string, code: string): void => {
  if (
    replicaId !== replicaId.toLowerCase() ||
    !/^0x[0-9a-f]{64}:0x[0-9a-f]{40}$/.test(replicaId)
  ) throw new Error(`${code}:${replicaId}`);
};

const assertAppliedReplicaEntity = (
  appliedReplicaId: string,
  context: EntityInfraContext,
): void => {
  const appliedEntityId = appliedReplicaId.split(':')[0];
  if (appliedEntityId !== context.entityId) {
    throw new Error(`STORAGE_ENTITY_CONTEXT_REPLICA_BINDING:${appliedReplicaId}`);
  }
};

export const prepareEntityContextPayloadRows = (
  contexts: ReadonlyMap<string, EntityInfraContext>,
) => {
  const refs = new Map<string, EntityContextPayloadHash>();
  const rows = new Map<EntityContextPayloadHash, Readonly<{
    key: Buffer;
    value: Buffer;
  }>>();
  for (const [replicaId, context] of contexts) {
    assertReplicaId(replicaId, 'STORAGE_ENTITY_CONTEXT_REPLICA_ID_INVALID');
    const decoded = validateEntityInfraContext(context);
    // A catch-up frame is proposed by one signer and applied by another local
    // replica. The map key binds the recipient Entity; the payload's validated
    // proposerReplicaId independently binds the proposer identity.
    assertAppliedReplicaEntity(replicaId, decoded);
    const value = encodeBuffer(decoded, { omitSymbolKeys: true });
    if (value.byteLength > MAX_ENTITY_CONTEXT_PAYLOAD_BYTES) {
      throw new Error(
        `STORAGE_ENTITY_CONTEXT_PAYLOAD_TOO_LARGE:${replicaId}:` +
        `${value.byteLength}:max=${MAX_ENTITY_CONTEXT_PAYLOAD_BYTES}`,
      );
    }
    const hash = hashContext(value);
    refs.set(replicaId, hash);
    rows.set(hash, { key: keyEntityContextPayload(hash), value });
  }
  return { refs, rows: [...rows.values()] };
};

export const decodeEntityContextPayloadRefs = (
  value: unknown,
  code: string,
): Map<string, EntityContextPayloadHash> => {
  if (!(value instanceof Map) || value.size > 10_000) throw new Error(code);
  const refs = new Map<string, EntityContextPayloadHash>();
  for (const [replicaId, rawHash] of value) {
    if (typeof replicaId !== 'string' || typeof rawHash !== 'string') {
      throw new Error(`${code}:ENTRY`);
    }
    assertReplicaId(replicaId, `${code}:REPLICA_ID`);
    refs.set(replicaId, toEntityContextPayloadHash(rawHash.toLowerCase()));
  }
  return refs;
};

export const readEntityContextPayloads = async (
  db: Pick<RuntimeDbLike, 'get'>,
  refs: ReadonlyMap<string, EntityContextPayloadHash>,
): Promise<Map<string, EntityInfraContext>> => {
  const contexts = new Map<string, EntityInfraContext>();
  for (const [replicaId, ref] of refs) {
    let value: Buffer;
    try {
      value = await db.get(keyEntityContextPayload(ref));
    } catch (error) {
      throw new Error(`STORAGE_ENTITY_CONTEXT_PAYLOAD_MISSING:${replicaId}:${ref}`, {
        cause: error,
      });
    }
    if (value.byteLength > MAX_ENTITY_CONTEXT_PAYLOAD_BYTES) {
      throw new Error(`STORAGE_ENTITY_CONTEXT_PAYLOAD_TOO_LARGE:${replicaId}`);
    }
    const actual = hashContext(value);
    if (actual !== ref) {
      throw new Error(
        `STORAGE_ENTITY_CONTEXT_PAYLOAD_HASH_MISMATCH:${replicaId}:` +
        `expected=${ref}:actual=${actual}`,
      );
    }
    const context = decodeValidatedBuffer(value, validateEntityInfraContext);
    assertAppliedReplicaEntity(replicaId, context);
    contexts.set(replicaId, context);
  }
  return contexts;
};
