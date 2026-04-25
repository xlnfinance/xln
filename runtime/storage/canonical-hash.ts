import { ethers } from 'ethers';
import type { EntityReplica, Env } from '../types';

export type CanonicalFrameEntityHash = {
  entityId: string;
  hash: string;
  cellCount: number;
};

const VOLATILE_FIELDS = new Set([
  'clonedForValidation',
  'ethersProvider',
  'frameHistory',
  'provider',
]);

const normalizeEntityId = (value: string): string => String(value || '').toLowerCase();

const hashCanonical = (value: unknown): string =>
  ethers.keccak256(ethers.toUtf8Bytes(JSON.stringify(value)));

// Values are already canonicalized before sorting, so JSON.stringify is used
// only as a stable byte comparator for tagged/sorted structures.
const compareCanonical = (left: unknown, right: unknown): number =>
  JSON.stringify(left).localeCompare(JSON.stringify(right));

const nonEmptyMapOrNull = <K, V>(value: Map<K, V> | undefined): Map<K, V> | null =>
  value && value.size > 0 ? value : null;

export const canonicalizeStorageAuditValue = (value: unknown, stack: object[] = []): unknown => {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return { __xlnType: 'BigInt', value: value.toString() };
  if (typeof value === 'function' || typeof value === 'symbol') return null;
  if (value instanceof Date) return { __xlnType: 'Date', value: value.toISOString() };
  if (typeof Buffer !== 'undefined' && Buffer.isBuffer(value)) {
    return { __xlnType: 'Buffer', value: value.toString('hex') };
  }
  if (ArrayBuffer.isView(value)) {
    const view = value as ArrayBufferView;
    const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
    return {
      __xlnType: 'TypedArray',
      kind: value.constructor.name,
      value: Buffer.from(bytes).toString('hex'),
    };
  }

  const objectRef = value as object;
  if (stack.includes(objectRef)) return null;
  stack.push(objectRef);
  try {
    if (value instanceof Map) {
      const entries = Array.from(value.entries())
        .map(([key, entryValue]) => [canonicalizeStorageAuditValue(key, stack), canonicalizeStorageAuditValue(entryValue, stack)] as const)
        .sort((left, right) => {
          const byKey = compareCanonical(left[0], right[0]);
          return byKey !== 0 ? byKey : compareCanonical(left[1], right[1]);
        });
      return { __xlnType: 'Map', value: entries };
    }

    if (value instanceof Set) {
      return {
        __xlnType: 'Set',
        value: Array.from(value.values()).map((entry) => canonicalizeStorageAuditValue(entry, stack)).sort(compareCanonical),
      };
    }

    if (Array.isArray(value)) return value.map((entry) => canonicalizeStorageAuditValue(entry, stack));

    const record = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(record)
      .filter((entryKey) => !VOLATILE_FIELDS.has(entryKey))
      .sort((left, right) => left.localeCompare(right))) {
      if (record[key] === undefined) continue;
      out[key] = canonicalizeStorageAuditValue(record[key], stack);
    }
    return out;
  } finally {
    stack.pop();
  }
};

export const computeCanonicalEntityHash = (replica: EntityReplica): CanonicalFrameEntityHash => {
  const entityId = normalizeEntityId(replica.entityId || replica.state?.entityId || '');
  return {
    entityId,
    cellCount: 1,
    hash: hashCanonical({
      kind: 'xln.storage.canonicalEntityHash.v1',
      entityId,
      replica: canonicalizeStorageAuditValue({
        entityId: replica.entityId,
        signerId: replica.signerId,
        isProposer: replica.isProposer,
        state: replica.state,
        proposal: replica.proposal ?? null,
        lockedFrame: replica.lockedFrame ?? null,
        validatorComputedState: replica.validatorComputedState ?? null,
        // Restore initializes missing witness state as an empty Map. Treat
        // empty/absent as the same value, but hash collected signatures.
        hankoWitness: nonEmptyMapOrNull(replica.hankoWitness),
      }),
    }),
  };
};

export const computeCanonicalEntityHashesFromEnv = (env: Env): CanonicalFrameEntityHash[] =>
  Array.from(env.eReplicas.values())
    .filter((replica): replica is EntityReplica => Boolean(replica?.state))
    .map((replica) => computeCanonicalEntityHash(replica))
    .sort((left, right) => left.entityId.localeCompare(right.entityId));

export const computeCanonicalRuntimeStateHash = (
  height: number,
  timestamp: number,
  entityHashes: CanonicalFrameEntityHash[],
): string =>
  hashCanonical({
    kind: 'xln.storage.canonicalRuntimeHash.v1',
    height,
    timestamp,
    entities: entityHashes
      .map((entry) => ({
        entityId: normalizeEntityId(entry.entityId),
        hash: entry.hash,
        cellCount: entry.cellCount,
      }))
      .sort((left, right) => left.entityId.localeCompare(right.entityId)),
  });

export const computeCanonicalStateHashFromEnv = (env: Env): string =>
  computeCanonicalRuntimeStateHash(env.height, env.timestamp, computeCanonicalEntityHashesFromEnv(env));
