import { validateJInputs } from './j';
import {
  validateNumberedRecord,
  validatePendingImport,
  validateRegistrationEvidence,
} from '../../../runtime/decode/registrations';
import {
  requireBoundaryInteger,
  requireBoundaryRecord,
  requireExactBoundaryKeys,
  requireMap,
  requireString,
  validateStorageSafeValue,
  validateStringMap,
} from '../../../protocol/boundary/boundary-primitives';

export const validateDurableRuntimeState = (value: unknown, code: string): void => {
  const state = requireBoundaryRecord(value, code);
  requireExactBoundaryKeys(state, [], [
    'maxEntityInputsPerFrame', 'maxEntityTxsPerFrame',
    'pendingAuditEvents',
    'runtimeAdapterCommandFrontiers', 'pendingCommittedJOutbox', 'pendingJurisdictionImports',
    'numberedRegistrationIntents', 'certifiedRegistrationEvidence',
    'entityEncryptionSeeds',
    'certifiedBoardNodes', 'accountJClaimNodes',
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
  for (const field of ['certifiedBoardNodes', 'accountJClaimNodes']) {
    if (state[field] === undefined) continue;
    validateStringMap(state[field], `${code}_${field.toUpperCase()}`, (node, nodeCode) => {
      requireBoundaryRecord(node, nodeCode);
      validateStorageSafeValue(node, nodeCode);
    });
  }
};
