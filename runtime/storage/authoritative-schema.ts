import { validateRuntimeInputEnvelope } from '../protocol/boundary-validation';
import { assertStorageSchemaVersion } from './keys';
import type {
  StorageDiffRecord,
  StorageDoc,
  StorageDocRef,
  StorageFrameEntityHash,
  StorageFrameRecord,
  StorageHead,
  StorageSnapshotManifest,
} from './types';
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
import {
  validateStorageAccountDocValue,
  validateStorageBookDocValue,
  validateStorageEntityCoreDocValue,
} from './schema-state-docs';
import { validateDurableRuntimeMachineSnapshot } from '../wal/runtime-machine-schema';

export * from './schema-state-docs';
export * from './schema-merkle-cas';

export const validateStorageHeadValue = (value: unknown): StorageHead => {
  const code = 'STORAGE_HEAD_INVALID';
  const head = requireBoundaryRecord(value, code);
  requireExactBoundaryKeys(head, [
    'schemaVersion', 'latestHeight', 'latestMaterializedHeight', 'latestSnapshotHeight',
    'snapshotPeriodFrames', 'retainSnapshots', 'epochMaxBytes', 'accountMerkleRadix',
    'retainedHistoryBytes',
  ], [], `${code}_FIELDS`);
  assertStorageSchemaVersion(head['schemaVersion'], 'storage-head');
  for (const key of ['latestHeight', 'latestMaterializedHeight', 'latestSnapshotHeight', 'retainedHistoryBytes']) {
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

export const validateStorageFrameRecordValue = (value: unknown): StorageFrameRecord => {
  const code = 'STORAGE_FRAME_INVALID';
  const frame = requireBoundaryRecord(value, code);
  requireExactBoundaryKeys(frame, [
    'height', 'timestamp', 'prevFrameHash', 'frameHash', 'replicaMetaDigest', 'stateHash',
    'hashMode', 'materializedState', 'entityHashes', 'runtimeStateHash', 'runtimeInput',
    'runtimeMachineBeforeApply', 'runtimeMachine', 'touchedEntities', 'touchedAccounts',
    'touchedBookEntities',
  ], ['canonicalStateHash', 'canonicalEntityHashes', 'runtimeOutputs', 'overlayRecords'], `${code}_FIELDS`);
  requireBoundaryInteger(frame['height'], `${code}_HEIGHT`, 1);
  requireBoundaryInteger(frame['timestamp'], `${code}_TIMESTAMP`);
  requireStorageHash(frame['prevFrameHash'], `${code}_PREV_HASH`);
  requireStorageHash(frame['frameHash'], `${code}_FRAME_HASH`);
  requireStorageHash(frame['replicaMetaDigest'], `${code}_REPLICA_META_DIGEST`);
  if (typeof frame['stateHash'] !== 'string') throw new Error(`${code}_STATE_HASH`);
  if (frame['hashMode'] !== 'storage-merkle-v1') throw new Error(`${code}_HASH_MODE`);
  requireStorageBoolean(frame['materializedState'], `${code}_MATERIALIZED`);
  validateFrameEntityHashes(frame['entityHashes'], `${code}_ENTITY_HASHES`);
  requireStorageHash(frame['runtimeStateHash'], `${code}_RUNTIME_STATE_HASH`);
  validateRuntimeInputEnvelope(frame['runtimeInput'], `${code}_RUNTIME_INPUT`);
  frame['runtimeMachineBeforeApply'] = validateDurableRuntimeMachineSnapshot(
    frame['runtimeMachineBeforeApply'],
    `${code}_MACHINE_BEFORE`,
  );
  frame['runtimeMachine'] = validateDurableRuntimeMachineSnapshot(
    frame['runtimeMachine'],
    `${code}_MACHINE`,
  );
  requireStringArray(frame['touchedEntities'], `${code}_TOUCHED_ENTITIES`);
  validateTouchedAccounts(frame['touchedAccounts'], `${code}_TOUCHED_ACCOUNTS`);
  requireStringArray(frame['touchedBookEntities'], `${code}_TOUCHED_BOOK_ENTITIES`);
  validateOptionalFrameFields(frame, code);
  return frame as StorageFrameRecord;
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
  if (frame['runtimeOutputs'] !== undefined) requireStorageArray(frame['runtimeOutputs'], `${code}_OUTPUTS`);
  if (frame['overlayRecords'] !== undefined) requireStorageArray(frame['overlayRecords'], `${code}_OVERLAYS`);
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

const validateStorageDoc = (value: unknown, code: string): StorageDoc => {
  const doc = requireBoundaryRecord(value, code);
  if (doc['family'] === 'entity') {
    requireExactBoundaryKeys(doc, ['family', 'entityId', 'value'], [], `${code}_FIELDS`);
    requireStorageString(doc['entityId'], `${code}_ENTITY_ID`);
    const core = validateStorageEntityCoreDocValue(doc['value']);
    if (core.entityId !== doc['entityId']) throw new Error(`${code}_ENTITY_VALUE_ID_MISMATCH`);
  } else if (doc['family'] === 'account') {
    requireExactBoundaryKeys(doc, ['family', 'entityId', 'counterpartyId', 'value'], [], `${code}_FIELDS`);
    requireStorageString(doc['entityId'], `${code}_ENTITY_ID`);
    requireStorageString(doc['counterpartyId'], `${code}_COUNTERPARTY_ID`);
    const account = validateStorageAccountDocValue(doc['value']);
    const endpoints = new Set([account.leftEntity, account.rightEntity]);
    if (!endpoints.has(String(doc['entityId'])) || !endpoints.has(String(doc['counterpartyId']))) {
      throw new Error(`${code}_ACCOUNT_ENDPOINT_MISMATCH`);
    }
  } else if (doc['family'] === 'book') {
    requireExactBoundaryKeys(doc, ['family', 'entityId', 'pairId', 'value'], [], `${code}_FIELDS`);
    requireStorageString(doc['entityId'], `${code}_ENTITY_ID`);
    requireStorageString(doc['pairId'], `${code}_PAIR_ID`);
    validateStorageBookDocValue(doc['value']);
  } else throw new Error(`${code}_FAMILY`);
  return doc as StorageDoc;
};

const validateStorageDocRef = (value: unknown, code: string): StorageDocRef => {
  const ref = requireBoundaryRecord(value, code);
  if (ref['family'] === 'entity') requireExactBoundaryKeys(ref, ['family', 'entityId'], [], `${code}_FIELDS`);
  else if (ref['family'] === 'account') requireExactBoundaryKeys(ref, ['family', 'entityId', 'counterpartyId'], [], `${code}_FIELDS`);
  else if (ref['family'] === 'book') requireExactBoundaryKeys(ref, ['family', 'entityId', 'pairId'], [], `${code}_FIELDS`);
  else throw new Error(`${code}_FAMILY`);
  requireStorageString(ref['entityId'], `${code}_ENTITY_ID`);
  if (ref['family'] === 'account') requireStorageString(ref['counterpartyId'], `${code}_COUNTERPARTY_ID`);
  if (ref['family'] === 'book') requireStorageString(ref['pairId'], `${code}_PAIR_ID`);
  return ref as StorageDocRef;
};

export const validateStorageDiffRecordValue = (value: unknown): StorageDiffRecord => {
  const code = 'STORAGE_DIFF_INVALID';
  const diff = requireBoundaryRecord(value, code);
  requireExactBoundaryKeys(diff, ['height', 'puts', 'dels'], [], `${code}_FIELDS`);
  requireBoundaryInteger(diff['height'], `${code}_HEIGHT`, 1);
  const puts = requireStorageArray(diff['puts'], `${code}_PUTS`).map((doc, index) => validateStorageDoc(doc, `${code}_PUT_${index}`));
  const dels = requireStorageArray(diff['dels'], `${code}_DELS`).map((ref, index) => validateStorageDocRef(ref, `${code}_DEL_${index}`));
  return { height: Number(diff['height']), puts, dels };
};
