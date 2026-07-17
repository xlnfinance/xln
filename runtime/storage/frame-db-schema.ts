import { validateAccountFrame } from '../validation-utils';
import {
  requireBoundaryInteger,
  requireBoundaryRecord,
  requireExactBoundaryKeys,
  validateFrameLogEntries,
} from '../protocol/boundary-validation';
import { assertStorageSchemaVersion } from './keys';
import type { StoredAccountFrameValue, StoredRuntimeActivityValue } from './frame-db';
import type { StorageFrameDbHead } from './types';

const requireStringArray = (value: unknown, code: string): string[] => {
  if (!Array.isArray(value) || value.some(entry => typeof entry !== 'string' || entry.length === 0)) {
    throw new Error(code);
  }
  return value;
};

export const validateFrameDbHeadValue = (value: unknown): StorageFrameDbHead => {
  const head = requireBoundaryRecord(value, 'FRAME_DB_HEAD_INVALID');
  requireExactBoundaryKeys(
    head,
    ['schemaVersion', 'latestHeight', 'latestPrunedRuntimeHeight', 'retainedBytes', 'maxBytes', 'retainFrames'],
    [],
    'FRAME_DB_HEAD_FIELDS_INVALID',
  );
  const schemaVersion = assertStorageSchemaVersion(head['schemaVersion'], 'frame-db-head');
  return {
    schemaVersion,
    latestHeight: requireBoundaryInteger(head['latestHeight'], 'FRAME_DB_HEAD_LATEST_HEIGHT_INVALID'),
    latestPrunedRuntimeHeight: requireBoundaryInteger(
      head['latestPrunedRuntimeHeight'],
      'FRAME_DB_HEAD_PRUNED_HEIGHT_INVALID',
    ),
    retainedBytes: requireBoundaryInteger(head['retainedBytes'], 'FRAME_DB_HEAD_RETAINED_BYTES_INVALID'),
    maxBytes: requireBoundaryInteger(head['maxBytes'], 'FRAME_DB_HEAD_MAX_BYTES_INVALID', 1),
    retainFrames: requireBoundaryInteger(head['retainFrames'], 'FRAME_DB_HEAD_RETAIN_FRAMES_INVALID', 1),
  };
};

const validateCompactRuntimeInput = (
  value: unknown,
  height: number,
): StoredRuntimeActivityValue['runtimeInput'] => {
  const code = `FRAME_DB_RUNTIME_ACTIVITY_INPUT_INVALID:height=${height}`;
  const input = requireBoundaryRecord(value, code);
  requireExactBoundaryKeys(input, ['entityInputs'], ['jInputs'], `${code}:fields`);
  if (!Array.isArray(input['entityInputs'])) throw new Error(code);
  for (const [index, rawEntry] of input['entityInputs'].entries()) {
    const entryCode = `FRAME_DB_RUNTIME_ACTIVITY_ENTITY_INPUT_INVALID:height=${height}:index=${index}`;
    const entry = requireBoundaryRecord(rawEntry, entryCode);
    requireExactBoundaryKeys(entry, ['entityId'], ['entityTxs'], `${entryCode}:fields`);
    if (typeof entry['entityId'] !== 'string' || entry['entityId'].length === 0) throw new Error(entryCode);
    if (entry['entityTxs'] !== undefined) {
      if (!Array.isArray(entry['entityTxs'])) throw new Error(entryCode);
      for (const tx of entry['entityTxs']) {
        const txRecord = requireBoundaryRecord(tx, entryCode);
        if (typeof txRecord['type'] !== 'string' || txRecord['type'].length === 0) throw new Error(entryCode);
      }
    }
  }
  if (input['jInputs'] !== undefined) {
    if (!Array.isArray(input['jInputs'])) throw new Error(`${code}:jInputs`);
    for (const [index, rawEntry] of input['jInputs'].entries()) {
      const entryCode = `${code}:jInput=${index}`;
      const entry = requireBoundaryRecord(rawEntry, entryCode);
      requireExactBoundaryKeys(entry, ['jurisdictionName', 'jTxs'], [], `${entryCode}:fields`);
      if (typeof entry['jurisdictionName'] !== 'string' || !Array.isArray(entry['jTxs'])) throw new Error(entryCode);
    }
  }
  return input as unknown as StoredRuntimeActivityValue['runtimeInput'];
};

export const validateStoredRuntimeActivityValue = (
  value: unknown,
  height: number,
): StoredRuntimeActivityValue => {
  const activity = requireBoundaryRecord(value, `FRAME_DB_RUNTIME_ACTIVITY_INVALID:height=${height}`);
  requireExactBoundaryKeys(
    activity,
    ['timestamp', 'runtimeInput', 'logs', 'touchedEntities', 'touchedAccounts', 'touchedBookEntities'],
    [],
    `FRAME_DB_RUNTIME_ACTIVITY_FIELDS_INVALID:height=${height}`,
  );
  const touchedEntities = requireStringArray(
    activity['touchedEntities'],
    `FRAME_DB_RUNTIME_ACTIVITY_TOUCHED_ENTITIES_INVALID:height=${height}`,
  );
  const touchedBookEntities = requireStringArray(
    activity['touchedBookEntities'],
    `FRAME_DB_RUNTIME_ACTIVITY_TOUCHED_BOOK_ENTITIES_INVALID:height=${height}`,
  );
  if (!Array.isArray(activity['touchedAccounts'])) {
    throw new Error(`FRAME_DB_RUNTIME_ACTIVITY_TOUCHED_ACCOUNTS_INVALID:height=${height}`);
  }
  const touchedAccounts = activity['touchedAccounts'].map((rawEntry, index) => {
    const code = `FRAME_DB_RUNTIME_ACTIVITY_TOUCHED_ACCOUNT_INVALID:height=${height}:index=${index}`;
    const entry = requireBoundaryRecord(rawEntry, code);
    requireExactBoundaryKeys(entry, ['entityId', 'counterpartyId'], [], `${code}:fields`);
    if (typeof entry['entityId'] !== 'string' || typeof entry['counterpartyId'] !== 'string') throw new Error(code);
    return { entityId: entry['entityId'], counterpartyId: entry['counterpartyId'] };
  });
  return {
    timestamp: requireBoundaryInteger(
      activity['timestamp'],
      `FRAME_DB_RUNTIME_ACTIVITY_TIMESTAMP_INVALID:height=${height}`,
    ),
    runtimeInput: validateCompactRuntimeInput(activity['runtimeInput'], height),
    logs: validateFrameLogEntries(
      activity['logs'],
      `FRAME_DB_RUNTIME_ACTIVITY_LOGS_INVALID:height=${height}`,
    ),
    touchedEntities,
    touchedAccounts,
    touchedBookEntities,
  };
};

export const validateStoredAccountFrameValue = (
  value: unknown,
  accountHeight: number,
): StoredAccountFrameValue => {
  const code = `FRAME_DB_ACCOUNT_FRAME_FIELDS_INVALID:height=${accountHeight}`;
  const record = requireBoundaryRecord(value, code);
  requireExactBoundaryKeys(record, ['source', 'frame', 'runtimeHeight', 'timestamp'], [], code);
  if (record['source'] !== 'ackCommit' && record['source'] !== 'peerCommit') {
    throw new Error(`FRAME_DB_ACCOUNT_FRAME_SOURCE_INVALID:height=${accountHeight}`);
  }
  const frameRecord = requireBoundaryRecord(record['frame'], `FRAME_DB_ACCOUNT_FRAME_INVALID:height=${accountHeight}`);
  requireExactBoundaryKeys(
    frameRecord,
    ['height', 'timestamp', 'jHeight', 'accountTxs', 'prevFrameHash', 'accountStateRoot', 'stateHash', 'deltas'],
    ['byLeft'],
    `FRAME_DB_ACCOUNT_FRAME_FIELDS_INVALID:height=${accountHeight}:frame`,
  );
  return {
    source: record['source'],
    frame: validateAccountFrame(frameRecord, `FrameDb.AccountFrame[${accountHeight}]`),
    runtimeHeight: requireBoundaryInteger(
      record['runtimeHeight'],
      `FRAME_DB_ACCOUNT_FRAME_RUNTIME_HEIGHT_INVALID:height=${accountHeight}`,
      1,
    ),
    timestamp: requireBoundaryInteger(
      record['timestamp'],
      `FRAME_DB_ACCOUNT_FRAME_TIMESTAMP_INVALID:height=${accountHeight}`,
    ),
  };
};
