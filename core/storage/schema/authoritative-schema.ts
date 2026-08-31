import { decodeRuntimeInput } from '../../runtime/decode';
import { assertStorageSchemaVersion } from '../keys';
import type {
  StorageFrameEntityHash,
  RuntimeFrame,
  StorageHead,
  StorageSnapshotManifest,
  StorageRscoreCheckpointRef,
} from '../types';
import {
  requireBoundaryInteger,
  requireBoundaryRecord,
  requireExactBoundaryKeys,
  requireStorageArray,
  requireStorageBoolean,
  requireStorageHash,
  requireStorageRadix,
  requireStorageString,
  requireStringArray,
} from './schema-primitives';
import { toRuntimeOutputsDigest } from '../../protocol/hashes';
import { MAX_RUNTIME_OUTPUT_ROWS } from '../wal/outbox-payload';
import { decodeEntityContextPayloadRefs } from '../wal/entity-context-payload';
import { decodeRuntimeMachineGraphRoot } from '../wal/runtime-machine-graph';

export * from './schema-state-docs';
export * from './nodes/schema-merkle-nodes';

export const validateStorageHeadValue = (value: unknown): StorageHead => {
  const code = 'STORAGE_HEAD_INVALID';
  const head = requireBoundaryRecord(value, code);
  requireExactBoundaryKeys(head, [
    'schemaVersion', 'latestHeight', 'latestMaterializedHeight', 'latestSnapshotHeight',
    'snapshotPeriodFrames', 'retainSnapshots', 'epochMaxBytes', 'accountMerkleRadix',
    'epochReplayBytes', 'retainedWalBytes',
  ], [], `${code}_FIELDS`);
  assertStorageSchemaVersion(head['schemaVersion'], 'storage-head');
  for (const key of [
    'latestHeight',
    'latestMaterializedHeight',
    'latestSnapshotHeight',
    'epochReplayBytes',
    'retainedWalBytes',
  ]) {
    requireBoundaryInteger(head[key], `${code}_${key}`);
  }
  requireBoundaryInteger(head['snapshotPeriodFrames'], `${code}_SNAPSHOT_PERIOD`, 1);
  requireBoundaryInteger(head['retainSnapshots'], `${code}_RETAIN_SNAPSHOTS`, 1);
  requireBoundaryInteger(head['epochMaxBytes'], `${code}_EPOCH_BYTES`, 1);
  requireStorageRadix(head['accountMerkleRadix'], `${code}_RADIX`);
  if (Number(head['latestSnapshotHeight']) > Number(head['latestHeight'])) {
    throw new Error('STORAGE_VERIFY_SNAPSHOT_AFTER_HEAD');
  }
  if (Number(head['latestMaterializedHeight']) > Number(head['latestHeight'])) throw new Error(`${code}_MATERIALIZED_AFTER_HEAD`);
  return head as StorageHead;
};

const validateFrameEntityHashes = (value: unknown, code: string): StorageFrameEntityHash[] =>
  requireStorageArray(value, code).map((raw, index) => {
    const itemCode = `${code}_${index}`;
    const item = requireBoundaryRecord(raw, itemCode);
    requireExactBoundaryKeys(item, ['entityId', 'hash', 'cellCount'], [], `${itemCode}_FIELDS`);
    requireStorageString(item['entityId'], `${itemCode}_ENTITY_ID`);
    requireStorageHash(item['hash'], `${itemCode}_HASH`);
    requireBoundaryInteger(item['cellCount'], `${itemCode}_CELL_COUNT`);
    return item as StorageFrameEntityHash;
  });

const validateRscoreCheckpointRefs = (
  value: unknown,
  code: string,
): StorageRscoreCheckpointRef[] => {
  const owners = new Set<string>();
  let previous = '';
  return requireStorageArray(value, code).map((raw, index) => {
    const itemCode = `${code}_${index}`;
    const item = requireBoundaryRecord(raw, itemCode);
    requireExactBoundaryKeys(item, [
      'ownerEntityId', 'protocolFingerprint', 'baseRevision', 'revision',
      'accountsRoot', 'signerDigest', 'accountCount',
    ], [], `${itemCode}_FIELDS`);
    const owner = requireStorageHash(item['ownerEntityId'], `${itemCode}_OWNER`).toLowerCase();
    requireStorageHash(item['protocolFingerprint'], `${itemCode}_FINGERPRINT`);
    requireStorageHash(item['accountsRoot'], `${itemCode}_ACCOUNTS_ROOT`);
    requireStorageHash(item['signerDigest'], `${itemCode}_SIGNER_DIGEST`);
    for (const field of ['baseRevision', 'revision'] as const) {
      const revision = requireStorageString(item[field], `${itemCode}_${field}`);
      if (!/^(0|[1-9][0-9]*)$/.test(revision)) throw new Error(`${itemCode}_${field}_INVALID`);
    }
    if (item['baseRevision'] !== item['revision']) throw new Error(`${itemCode}_RESTORE_BASE`);
    const accountCount = requireBoundaryInteger(item['accountCount'], `${itemCode}_ACCOUNT_COUNT`);
    if (accountCount > 65_536) throw new Error(`${itemCode}_ACCOUNT_COUNT_MAX`);
    if (owners.has(owner) || (previous !== '' && previous >= owner)) {
      throw new Error(`${itemCode}_OWNER_ORDER`);
    }
    owners.add(owner);
    previous = owner;
    return item as StorageRscoreCheckpointRef;
  });
};

export const validateStorageFrameRecordValue = (value: unknown): RuntimeFrame => {
  const code = 'STORAGE_FRAME_INVALID';
  const frame = requireBoundaryRecord(value, code);
  requireExactBoundaryKeys(frame, [
    'height', 'timestamp', 'prevFrameHash', 'frameHash', 'replicaMetaDigest',
    'postStateHash', 'materializedState', 'runtimeInput',
    'runtimeOutputCount', 'runtimeOutputsDigest',
    'touchedEntities', 'touchedAccounts',
    'touchedBookEntities',
  ], ['canonicalStateHash', 'canonicalEntityHashes', 'runtimeMachineRoot', 'accountAuthorityCheckpoints', 'entityContextRefs'], `${code}_FIELDS`);
  requireBoundaryInteger(frame['height'], `${code}_HEIGHT`, 1);
  requireBoundaryInteger(frame['timestamp'], `${code}_TIMESTAMP`);
  requireStorageHash(frame['prevFrameHash'], `${code}_PREV_HASH`);
  requireStorageHash(frame['frameHash'], `${code}_FRAME_HASH`);
  requireStorageHash(frame['replicaMetaDigest'], `${code}_REPLICA_META_DIGEST`);
  requireStorageHash(frame['postStateHash'], `${code}_POST_STATE_HASH`);
  const outputCount = requireBoundaryInteger(
    frame['runtimeOutputCount'],
    `${code}_OUTPUT_COUNT`,
  );
  if (outputCount > MAX_RUNTIME_OUTPUT_ROWS) throw new Error(`${code}_OUTPUT_COUNT_MAX`);
  frame['runtimeOutputsDigest'] = toRuntimeOutputsDigest(
    requireStorageHash(frame['runtimeOutputsDigest'], `${code}_OUTPUTS_DIGEST`),
  );
  requireStorageBoolean(frame['materializedState'], `${code}_MATERIALIZED`);
  if (frame['materializedState'] === true) {
    if (frame['canonicalStateHash'] === undefined || frame['canonicalEntityHashes'] === undefined) {
      throw new Error(`${code}_MATERIALIZED_CANONICAL_ROOTS_REQUIRED`);
    }
  }
  if (frame['accountAuthorityCheckpoints'] !== undefined) {
    frame['accountAuthorityCheckpoints'] = validateRscoreCheckpointRefs(
      frame['accountAuthorityCheckpoints'],
      `${code}_ACCOUNT_AUTHORITY_CHECKPOINTS`,
    );
  }
  const requiresRuntimeMachine = frame['materializedState'] === true || frame['canonicalStateHash'] !== undefined;
  if (requiresRuntimeMachine || frame['runtimeMachineRoot'] !== undefined) {
    frame['runtimeMachineRoot'] = decodeRuntimeMachineGraphRoot(
      frame['runtimeMachineRoot'],
      `${code}_MACHINE_ROOT`,
    );
  }
  frame['runtimeInput'] = decodeRuntimeInput(
    frame['runtimeInput'],
    `${code}_RUNTIME_INPUT`,
  );
  if (frame['entityContextRefs'] !== undefined) {
    frame['entityContextRefs'] = decodeEntityContextPayloadRefs(
      frame['entityContextRefs'],
      `${code}_ENTITY_CONTEXT_REFS`,
    );
  }
  requireStringArray(frame['touchedEntities'], `${code}_TOUCHED_ENTITIES`);
  validateTouchedAccounts(frame['touchedAccounts'], `${code}_TOUCHED_ACCOUNTS`);
  requireStringArray(frame['touchedBookEntities'], `${code}_TOUCHED_BOOK_ENTITIES`);
  validateOptionalFrameFields(frame, code);
  return frame as RuntimeFrame;
};

const validateTouchedAccounts = (value: unknown, code: string): void => {
  for (const [index, raw] of requireStorageArray(value, code).entries()) {
    const item = requireBoundaryRecord(raw, `${code}_${index}`);
    requireExactBoundaryKeys(item, ['entityId', 'counterpartyId'], [], `${code}_${index}_FIELDS`);
    requireStorageString(item['entityId'], `${code}_${index}_ENTITY`);
    requireStorageString(item['counterpartyId'], `${code}_${index}_COUNTERPARTY`);
  }
};

const validateOptionalFrameFields = (frame: Record<string, unknown>, code: string): void => {
  if (frame['canonicalStateHash'] !== undefined) requireStorageHash(frame['canonicalStateHash'], `${code}_CANONICAL_HASH`);
  if (frame['canonicalEntityHashes'] !== undefined) validateFrameEntityHashes(frame['canonicalEntityHashes'], `${code}_CANONICAL_ENTITIES`);
  const canonicalFields = [
    frame['canonicalStateHash'],
    frame['canonicalEntityHashes'],
  ];
  if (canonicalFields.some(value => value !== undefined) && canonicalFields.some(value => value === undefined)) {
    throw new Error(`${code}_CANONICAL_CHECKPOINT_INCOMPLETE`);
  }
};

export const validateStorageSnapshotManifestValue = (value: unknown): StorageSnapshotManifest => {
  const code = 'STORAGE_SNAPSHOT_MANIFEST_INVALID';
  const manifest = requireBoundaryRecord(value, code);
  requireExactBoundaryKeys(manifest, ['height', 'createdAt', 'docCount'], [], `${code}_FIELDS`);
  requireBoundaryInteger(manifest['height'], `${code}_HEIGHT`, 1);
  requireBoundaryInteger(manifest['createdAt'], `${code}_CREATED_AT`);
  requireBoundaryInteger(manifest['docCount'], `${code}_DOC_COUNT`);
  return manifest as StorageSnapshotManifest;
};
