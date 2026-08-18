import { decodeAccountFrame } from '../../../account/validation/frame-validation';
import { validateJInputs } from './j';
import {
  validateNumberedRecord,
  validatePendingImport,
  validateRegistrationEvidence,
} from '../../../runtime/decode/registrations';
import {
  requireArray,
  requireBoundaryInteger,
  requireBoundaryRecord,
  requireExactBoundaryKeys,
  requireMap,
  requireString,
  validateStorageSafeValue,
  validateStringMap,
} from '../../../protocol/boundary/boundary-primitives';

const assertAccountFrameRecord = (value: unknown, code: string): void => {
  const record = requireBoundaryRecord(value, code);
  requireExactBoundaryKeys(
    record,
    ['kind', 'entityId', 'counterpartyId', 'accountHeight', 'source', 'frame'],
    ['runtimeHeight', 'timestamp'],
    `${code}_FIELDS`,
  );
  if (record['kind'] !== 'accountFrame') throw new Error(`${code}_KIND`);
  requireString(record['entityId'], `${code}_ENTITY`);
  requireString(record['counterpartyId'], `${code}_COUNTERPARTY`);
  requireBoundaryInteger(record['accountHeight'], `${code}_ACCOUNT_HEIGHT`);
  if (record['source'] !== 'ackCommit' && record['source'] !== 'peerCommit') throw new Error(`${code}_SOURCE`);
  const frame = requireBoundaryRecord(record['frame'], `${code}_FRAME`);
  requireExactBoundaryKeys(frame, [
    'height', 'timestamp', 'jHeight', 'accountTxs', 'prevFrameHash',
    'accountStateRoot', 'stateHash', 'deltas',
  ], ['byLeft'], `${code}_FRAME_FIELDS`);
  decodeAccountFrame(frame, code);
  if (record['runtimeHeight'] !== undefined) requireBoundaryInteger(record['runtimeHeight'], `${code}_RUNTIME_HEIGHT`);
  if (record['timestamp'] !== undefined) requireBoundaryInteger(record['timestamp'], `${code}_TIMESTAMP`);
};

export const validateDurableRuntimeState = (value: unknown, code: string): void => {
  const state = requireBoundaryRecord(value, code);
  requireExactBoundaryKeys(state, [], [
    'maxEntityInputsPerFrame', 'maxEntityTxsPerFrame',
    'pendingAuditEvents', 'pendingHistoryRecords', 'deferredNetworkMeta',
    'runtimeAdapterCommandFrontiers', 'pendingCommittedJOutbox', 'pendingJurisdictionImports',
    'numberedRegistrationIntents', 'certifiedRegistrationEvidence',
    'entityEncryptionSeeds',
    'certifiedBoardNodes', 'consumptionNodes', 'accountJClaimNodes',
  ], `${code}_FIELDS`);
  for (const field of ['maxEntityInputsPerFrame', 'maxEntityTxsPerFrame']) {
    if (state[field] !== undefined) requireBoundaryInteger(state[field], `${code}_${field.toUpperCase()}`, 1);
  }
  if (state['entityEncryptionSeeds'] !== undefined) {
    for (const [entityId, seed] of requireMap(state['entityEncryptionSeeds'], `${code}_ENTITY_ENCRYPTION_SEEDS`)) {
      if (typeof entityId !== 'string' || !/^0x[0-9a-f]{64}$/.test(entityId)) {
        throw new Error(`${code}_ENTITY_ENCRYPTION_SEED_ENTITY_ID`);
      }
      if (typeof seed !== 'string' || !/^0x[0-9a-f]{128}$/.test(seed)) {
        throw new Error(`${code}_ENTITY_ENCRYPTION_SEED_VALUE`);
      }
    }
  }
  if (state['pendingAuditEvents'] !== undefined) {
    const events = requireMap(state['pendingAuditEvents'], `${code}_PENDING_AUDIT_EVENTS`);
    for (const [key, event] of events) {
      requireString(key, `${code}_PENDING_AUDIT_EVENT_KEY`);
      requireBoundaryRecord(event, `${code}_PENDING_AUDIT_EVENT`);
      validateStorageSafeValue(event, `${code}_PENDING_AUDIT_EVENT`);
    }
  }
  if (state['pendingHistoryRecords'] !== undefined) requireArray(state['pendingHistoryRecords'], `${code}_HISTORY_VIEW`).forEach((entry, index) => assertAccountFrameRecord(entry, `${code}_HISTORY_VIEW_${index}`));
  if (state['deferredNetworkMeta'] !== undefined) validateStringMap(state['deferredNetworkMeta'], `${code}_DEFERRED_NETWORK`, (entry, entryCode) => {
    const meta = requireBoundaryRecord(entry, entryCode);
    requireExactBoundaryKeys(meta, ['attempts', 'nextRetryAt'], [], `${entryCode}_FIELDS`);
    requireBoundaryInteger(meta['attempts'], `${entryCode}_ATTEMPTS`);
    requireBoundaryInteger(meta['nextRetryAt'], `${entryCode}_NEXT_RETRY`);
  });
  if (state['runtimeAdapterCommandFrontiers'] !== undefined) validateStringMap(state['runtimeAdapterCommandFrontiers'], `${code}_COMMAND_FRONTIERS`, (entry, entryCode) => {
    const frontier = requireBoundaryRecord(entry, entryCode);
    requireExactBoundaryKeys(frontier, ['lastContiguousSequence', 'lastInputHash', 'lastCommandId', 'observedHeight', 'expiresAtMs'], [], `${entryCode}_FIELDS`);
    requireBoundaryInteger(frontier['lastContiguousSequence'], `${entryCode}_SEQUENCE`, 1);
    requireString(frontier['lastInputHash'], `${entryCode}_INPUT_HASH`);
    requireString(frontier['lastCommandId'], `${entryCode}_COMMAND_ID`);
    requireBoundaryInteger(frontier['observedHeight'], `${entryCode}_HEIGHT`);
    if (frontier['expiresAtMs'] !== null) requireBoundaryInteger(frontier['expiresAtMs'], `${entryCode}_EXPIRES`, 1);
  });
  if (state['pendingCommittedJOutbox'] !== undefined) validateJInputs(state['pendingCommittedJOutbox'], `${code}_PENDING_COMMITTED_J_OUTBOX`);
  if (state['pendingJurisdictionImports'] !== undefined) validateStringMap(state['pendingJurisdictionImports'], `${code}_PENDING_IMPORTS`, validatePendingImport);
  if (state['numberedRegistrationIntents'] !== undefined) validateStringMap(state['numberedRegistrationIntents'], `${code}_NUMBERED_INTENTS`, validateNumberedRecord);
  if (state['certifiedRegistrationEvidence'] !== undefined) validateStringMap(state['certifiedRegistrationEvidence'], `${code}_REGISTRATION_EVIDENCE`, validateRegistrationEvidence);
  for (const field of ['certifiedBoardNodes', 'consumptionNodes', 'accountJClaimNodes']) {
    if (state[field] === undefined) continue;
    validateStringMap(state[field], `${code}_${field.toUpperCase()}`, (node, nodeCode) => {
      requireBoundaryRecord(node, nodeCode);
      validateStorageSafeValue(node, nodeCode);
    });
  }
};
