import { validateConsensusConfig } from '../../entity/consensus/config-validation';
import { validateProposedEntityFrame } from '../../entity/consensus/frame/validation';
import { decodeAccountFrame } from '../../account/validation/frame-validation';
import { decodeAccountTxs } from '../../account/tx-validation';
import { validateEntityTxs } from '../../entity/tx-validation';
import { validateJInputs } from '../wal/runtime-machine-schema/j';
import {
  requireBoundaryInteger,
  requireBoundaryRecord,
  requireExactBoundaryKeys,
  validateFrameLogEntries,
} from '../../protocol/boundary-validation';
import { assertStorageSchemaVersion } from '../keys';
import type {
  StoredAccountFrameValue,
  StoredAccountSwapEventValue,
  StoredEntityFrameValue,
  StoredRuntimeActivityValue,
} from './history-view';
import type { StorageHistoryViewHead } from '../types';
import type { RuntimeHistoryRecord } from '../../runtime/types';

const requireStringArray = (value: unknown, code: string): string[] => {
  if (!Array.isArray(value) || value.some(entry => typeof entry !== 'string' || entry.length === 0)) {
    throw new Error(code);
  }
  return value;
};

export const validateHistoryViewHeadValue = (value: unknown): StorageHistoryViewHead => {
  const head = requireBoundaryRecord(value, 'HISTORY_VIEW_HEAD_INVALID');
  requireExactBoundaryKeys(
    head,
    ['schemaVersion', 'latestHeight', 'latestPrunedRuntimeHeight', 'retainedBytes', 'maxBytes', 'retainFrames'],
    [],
    'HISTORY_VIEW_HEAD_FIELDS_INVALID',
  );
  const schemaVersion = assertStorageSchemaVersion(head['schemaVersion'], 'history-view-head');
  return {
    schemaVersion,
    latestHeight: requireBoundaryInteger(head['latestHeight'], 'HISTORY_VIEW_HEAD_LATEST_HEIGHT_INVALID'),
    latestPrunedRuntimeHeight: requireBoundaryInteger(
      head['latestPrunedRuntimeHeight'],
      'HISTORY_VIEW_HEAD_PRUNED_HEIGHT_INVALID',
    ),
    retainedBytes: requireBoundaryInteger(head['retainedBytes'], 'HISTORY_VIEW_HEAD_RETAINED_BYTES_INVALID'),
    maxBytes: requireBoundaryInteger(head['maxBytes'], 'HISTORY_VIEW_HEAD_MAX_BYTES_INVALID', 1),
    retainFrames: requireBoundaryInteger(head['retainFrames'], 'HISTORY_VIEW_HEAD_RETAIN_FRAMES_INVALID', 1),
  };
};

const validateCompactRuntimeInput = (
  value: unknown,
  height: number,
): StoredRuntimeActivityValue['runtimeInput'] => {
  const code = `HISTORY_VIEW_RUNTIME_ACTIVITY_INPUT_INVALID:height=${height}`;
  const input = requireBoundaryRecord(value, code);
  requireExactBoundaryKeys(input, ['entityInputs'], ['jInputs'], `${code}:fields`);
  if (!Array.isArray(input['entityInputs'])) throw new Error(code);
  const entityInputs = input['entityInputs'].map((rawEntry, index) => {
    const entryCode = `HISTORY_VIEW_RUNTIME_ACTIVITY_ENTITY_INPUT_INVALID:height=${height}:index=${index}`;
    const entry = requireBoundaryRecord(rawEntry, entryCode);
    requireExactBoundaryKeys(entry, ['entityId'], ['entityTxs'], `${entryCode}:fields`);
    if (typeof entry['entityId'] !== 'string' || entry['entityId'].length === 0) throw new Error(entryCode);
    const entityTxs = entry['entityTxs'] === undefined
      ? undefined
      : validateEntityTxs(entry['entityTxs'], `${entryCode}:entityTxs`);
    return {
      entityId: entry['entityId'],
      ...(entityTxs === undefined ? {} : { entityTxs }),
    };
  });
  const jInputs = input['jInputs'] === undefined
    ? undefined
    : validateJInputs(input['jInputs'], `${code}:jInputs`);
  return {
    entityInputs,
    ...(jInputs === undefined ? {} : { jInputs }),
  };
};

export const validateStoredRuntimeActivityValue = (
  value: unknown,
  height: number,
): StoredRuntimeActivityValue => {
  const activity = requireBoundaryRecord(value, `HISTORY_VIEW_RUNTIME_ACTIVITY_INVALID:height=${height}`);
  requireExactBoundaryKeys(
    activity,
    ['timestamp', 'runtimeInput', 'logs', 'touchedEntities', 'touchedAccounts', 'touchedBookEntities'],
    [],
    `HISTORY_VIEW_RUNTIME_ACTIVITY_FIELDS_INVALID:height=${height}`,
  );
  const touchedEntities = requireStringArray(
    activity['touchedEntities'],
    `HISTORY_VIEW_RUNTIME_ACTIVITY_TOUCHED_ENTITIES_INVALID:height=${height}`,
  );
  const touchedBookEntities = requireStringArray(
    activity['touchedBookEntities'],
    `HISTORY_VIEW_RUNTIME_ACTIVITY_TOUCHED_BOOK_ENTITIES_INVALID:height=${height}`,
  );
  if (!Array.isArray(activity['touchedAccounts'])) {
    throw new Error(`HISTORY_VIEW_RUNTIME_ACTIVITY_TOUCHED_ACCOUNTS_INVALID:height=${height}`);
  }
  const touchedAccounts = activity['touchedAccounts'].map((rawEntry, index) => {
    const code = `HISTORY_VIEW_RUNTIME_ACTIVITY_TOUCHED_ACCOUNT_INVALID:height=${height}:index=${index}`;
    const entry = requireBoundaryRecord(rawEntry, code);
    requireExactBoundaryKeys(entry, ['entityId', 'counterpartyId'], [], `${code}:fields`);
    if (typeof entry['entityId'] !== 'string' || typeof entry['counterpartyId'] !== 'string') throw new Error(code);
    return { entityId: entry['entityId'], counterpartyId: entry['counterpartyId'] };
  });
  return {
    timestamp: requireBoundaryInteger(
      activity['timestamp'],
      `HISTORY_VIEW_RUNTIME_ACTIVITY_TIMESTAMP_INVALID:height=${height}`,
    ),
    runtimeInput: validateCompactRuntimeInput(activity['runtimeInput'], height),
    logs: validateFrameLogEntries(
      activity['logs'],
      `HISTORY_VIEW_RUNTIME_ACTIVITY_LOGS_INVALID:height=${height}`,
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
  const code = `HISTORY_VIEW_ACCOUNT_FRAME_FIELDS_INVALID:height=${accountHeight}`;
  const record = requireBoundaryRecord(value, code);
  requireExactBoundaryKeys(record, ['source', 'frame', 'runtimeHeight', 'timestamp'], [], code);
  if (record['source'] !== 'ackCommit' && record['source'] !== 'peerCommit') {
    throw new Error(`HISTORY_VIEW_ACCOUNT_FRAME_SOURCE_INVALID:height=${accountHeight}`);
  }
  const frameRecord = requireBoundaryRecord(record['frame'], `HISTORY_VIEW_ACCOUNT_FRAME_INVALID:height=${accountHeight}`);
  requireExactBoundaryKeys(
    frameRecord,
    ['height', 'timestamp', 'jHeight', 'accountTxs', 'prevFrameHash', 'accountStateRoot', 'stateHash', 'deltas'],
    ['byLeft'],
    `HISTORY_VIEW_ACCOUNT_FRAME_FIELDS_INVALID:height=${accountHeight}:frame`,
  );
  return {
    source: record['source'],
    frame: decodeAccountFrame(frameRecord, `HistoryView.AccountFrame[${accountHeight}]`),
    runtimeHeight: requireBoundaryInteger(
      record['runtimeHeight'],
      `HISTORY_VIEW_ACCOUNT_FRAME_RUNTIME_HEIGHT_INVALID:height=${accountHeight}`,
      1,
    ),
    timestamp: requireBoundaryInteger(
      record['timestamp'],
      `HISTORY_VIEW_ACCOUNT_FRAME_TIMESTAMP_INVALID:height=${accountHeight}`,
    ),
  };
};

export const validateStoredAccountSwapEventValue = (
  value: unknown,
  accountHeight: number,
): StoredAccountSwapEventValue => {
  const code = `HISTORY_VIEW_ACCOUNT_SWAP_EVENT_INVALID:height=${accountHeight}`;
  const record = requireBoundaryRecord(value, code);
  requireExactBoundaryKeys(record, ['runtimeHeight', 'timestamp', 'accountHeight', 'tx'], [], code);
  const storedHeight = requireBoundaryInteger(record['accountHeight'], `${code}:accountHeight`, 1);
  if (storedHeight !== accountHeight) throw new Error(`${code}:height_mismatch`);
  const tx = decodeAccountTxs([record['tx']], `${code}:tx`)[0];
  if (
    !tx
    || (tx.type !== 'swap_offer'
      && tx.type !== 'swap_cancel_request'
      && tx.type !== 'swap_resolve'
      && tx.type !== 'cross_swap_fill_ack')
  ) throw new Error(`${code}:tx_kind`);
  return {
    runtimeHeight: requireBoundaryInteger(record['runtimeHeight'], `${code}:runtimeHeight`, 1),
    timestamp: requireBoundaryInteger(record['timestamp'], `${code}:timestamp`),
    accountHeight: storedHeight,
    tx,
  };
};

export const validateStoredEntityFrameValue = (
  value: unknown,
  entityHeight: number,
): StoredEntityFrameValue => {
  const code = `HISTORY_VIEW_ENTITY_FRAME_FIELDS_INVALID:height=${entityHeight}`;
  const record = requireBoundaryRecord(value, code);
  requireExactBoundaryKeys(record, ['link', 'runtimeHeight', 'timestamp'], [], code);
  const link = requireBoundaryRecord(record['link'], `${code}:link`);
  requireExactBoundaryKeys(link, ['frame', 'postAuthority'], [], `${code}:link`);
  const frame = validateProposedEntityFrame(link['frame'], `HistoryView.EntityFrame[${entityHeight}]`);
  if (frame.height !== entityHeight) {
    throw new Error(`HISTORY_VIEW_ENTITY_FRAME_HEIGHT_MISMATCH:key=${entityHeight}:frame=${frame.height}`);
  }
  const authority = requireBoundaryRecord(link['postAuthority'], `${code}:postAuthority`);
  requireExactBoundaryKeys(authority, ['config', 'leaderState'], [], `${code}:postAuthority`);
  const config = validateConsensusConfig(authority['config'], `${code}:postAuthority.config`);
  const leaderState = requireBoundaryRecord(authority['leaderState'], `${code}:postAuthority.leaderState`);
  requireExactBoundaryKeys(
    leaderState,
    ['activeValidatorId', 'view', 'changedAtHeight'],
    [],
    `${code}:postAuthority.leaderState`,
  );
  if (typeof leaderState['activeValidatorId'] !== 'string' || leaderState['activeValidatorId'].length === 0) {
    throw new Error(`${code}:postAuthority.leaderState.activeValidatorId`);
  }
  const view = requireBoundaryInteger(leaderState['view'], `${code}:postAuthority.leaderState.view`);
  const changedAtHeight = requireBoundaryInteger(
    leaderState['changedAtHeight'],
    `${code}:postAuthority.leaderState.changedAtHeight`,
  );
  return {
    link: {
      frame,
      postAuthority: {
        config,
        leaderState: {
          activeValidatorId: leaderState['activeValidatorId'],
          view,
          changedAtHeight,
        },
      },
    },
    runtimeHeight: requireBoundaryInteger(record['runtimeHeight'], `${code}:runtimeHeight`, 1),
    timestamp: requireBoundaryInteger(record['timestamp'], `${code}:timestamp`),
  };
};

export const validateRuntimeHistoryRecords = (
  value: unknown,
  runtimeHeight: number,
  runtimeTimestamp: number,
): RuntimeHistoryRecord[] => {
  if (!Array.isArray(value)) throw new Error('STORAGE_HISTORY_RECORDS_INVALID');
  return value.map((raw, index) => {
    const code = `STORAGE_HISTORY_RECORD_INVALID:index=${index}`;
    const record = requireBoundaryRecord(raw, code);
    if (record['kind'] === 'accountFrame') {
      requireExactBoundaryKeys(
        record,
        ['kind', 'entityId', 'counterpartyId', 'accountHeight', 'source', 'frame', 'runtimeHeight', 'timestamp'],
        [],
        `${code}:fields`,
      );
      if (typeof record['entityId'] !== 'string' || typeof record['counterpartyId'] !== 'string') {
        throw new Error(`${code}:identity`);
      }
      const accountHeight = requireBoundaryInteger(record['accountHeight'], `${code}:accountHeight`, 1);
      const stored = validateStoredAccountFrameValue({
        source: record['source'],
        frame: record['frame'],
        runtimeHeight: record['runtimeHeight'],
        timestamp: record['timestamp'],
      }, accountHeight);
      if (stored.runtimeHeight !== runtimeHeight || stored.timestamp !== runtimeTimestamp) {
        throw new Error(
          `${code}:runtime_binding:expected=${runtimeHeight}/${runtimeTimestamp}:` +
          `actual=${stored.runtimeHeight}/${stored.timestamp}`,
        );
      }
      return {
        kind: 'accountFrame',
        entityId: record['entityId'],
        counterpartyId: record['counterpartyId'],
        accountHeight,
        source: stored.source,
        frame: stored.frame,
        runtimeHeight: stored.runtimeHeight,
        timestamp: stored.timestamp,
      };
    } else if (record['kind'] === 'entityFrame') {
      requireExactBoundaryKeys(
        record,
        ['kind', 'entityId', 'entityHeight', 'link', 'runtimeHeight', 'timestamp'],
        [],
        `${code}:fields`,
      );
      if (typeof record['entityId'] !== 'string') throw new Error(`${code}:entityId`);
      const entityHeight = requireBoundaryInteger(record['entityHeight'], `${code}:entityHeight`, 1);
      const stored = validateStoredEntityFrameValue({
        link: record['link'],
        runtimeHeight: record['runtimeHeight'],
        timestamp: record['timestamp'],
      }, entityHeight);
      if (stored.runtimeHeight !== runtimeHeight || stored.timestamp !== runtimeTimestamp) {
        throw new Error(
          `${code}:runtime_binding:expected=${runtimeHeight}/${runtimeTimestamp}:` +
          `actual=${stored.runtimeHeight}/${stored.timestamp}`,
        );
      }
      return {
        kind: 'entityFrame',
        entityId: record['entityId'],
        entityHeight,
        link: stored.link,
        runtimeHeight: stored.runtimeHeight,
        timestamp: stored.timestamp,
      };
    } else {
      throw new Error(`${code}:kind`);
    }
  });
};
