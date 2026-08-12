import { decodeAccountFrame } from '../../../account/validation/frame-validation';
import { validateJInputs } from './j';
import {
  validateNumberedRecord,
  validatePendingImport,
  validateRegistrationEvidence,
} from '../../../runtime/input-schema/registrations';
import {
  requireArray,
  requireBoundaryInteger,
  requireBoundaryRecord,
  requireExactBoundaryKeys,
  requireMap,
  requireSet,
  requireString,
  validateStorageSafeValue,
  validateStringMap,
} from '../../../protocol/boundary-primitives';

const DELIVERY_KINDS = new Set([
  'entity-frame', 'hash-precommit', 'leader-timeout-vote', 'account-ack',
  'account-board-reseal', 'j-prefix-attestation', 'j-finality',
]);
const EVIDENCE_KINDS = new Set([
  'entity-proposal', 'entity-certificate', 'hash-precommit', 'leader-timeout-vote',
  'account-ack', 'account-frame-ack', 'account-board-reseal', 'j-prefix-attestation', 'j-finality',
]);

const validateReliableIdentity = (value: unknown, code: string): void => {
  const identity = requireBoundaryRecord(value, code);
  requireExactBoundaryKeys(identity, [
    'kind', 'entityId', 'signerId', 'laneKey', 'height', 'frameHash', 'logicalKey',
    'evidenceVersion', 'evidenceKind', 'evidenceDigest',
  ], ['logIndex', 'bodyDigest', 'evidenceBindings'], `${code}_FIELDS`);
  if (!DELIVERY_KINDS.has(String(identity['kind']))) throw new Error(`${code}_KIND`);
  for (const field of ['entityId', 'signerId', 'laneKey', 'frameHash', 'logicalKey', 'evidenceDigest']) {
    requireString(identity[field], `${code}_${field.toUpperCase()}`);
  }
  requireBoundaryInteger(identity['height'], `${code}_HEIGHT`);
  if (identity['logIndex'] !== undefined) requireBoundaryInteger(identity['logIndex'], `${code}_LOG_INDEX`);
  if (identity['evidenceVersion'] !== 1) throw new Error(`${code}_EVIDENCE_VERSION`);
  if (!EVIDENCE_KINDS.has(String(identity['evidenceKind']))) throw new Error(`${code}_EVIDENCE_KIND`);
  if (identity['bodyDigest'] !== undefined) requireString(identity['bodyDigest'], `${code}_BODY_DIGEST`);
  if (identity['evidenceBindings'] !== undefined) {
    for (const [index, raw] of requireArray(identity['evidenceBindings'], `${code}_BINDINGS`).entries()) {
      const binding = requireBoundaryRecord(raw, `${code}_BINDING_${index}`);
      requireExactBoundaryKeys(binding, ['subject', 'digest'], [], `${code}_BINDING_${index}_FIELDS`);
      requireString(binding['subject'], `${code}_BINDING_${index}_SUBJECT`);
      requireString(binding['digest'], `${code}_BINDING_${index}_DIGEST`);
    }
  }
};

export const validateReliableReceipt = (value: unknown, code: string): void => {
  const receipt = requireBoundaryRecord(value, code);
  requireExactBoundaryKeys(receipt, ['body', 'signature'], [], `${code}_FIELDS`);
  const body = requireBoundaryRecord(receipt['body'], `${code}_BODY`);
  requireExactBoundaryKeys(
    body,
    ['version', 'coverage', 'receiverRuntimeId', 'identity', 'appliedRuntimeHeight'],
    [],
    `${code}_BODY_FIELDS`,
  );
  if (body['version'] !== 1) throw new Error(`${code}_BODY_VERSION`);
  if (body['coverage'] !== 'exact' && body['coverage'] !== 'terminal') throw new Error(`${code}_BODY_COVERAGE`);
  requireString(body['receiverRuntimeId'], `${code}_BODY_RECEIVER`);
  validateReliableIdentity(body['identity'], `${code}_BODY_IDENTITY`);
  requireBoundaryInteger(body['appliedRuntimeHeight'], `${code}_BODY_HEIGHT`);
  requireString(receipt['signature'], `${code}_SIGNATURE`);
};

const validatePendingIngress = (value: unknown, code: string): void => {
  const pending = requireBoundaryRecord(value, code);
  requireExactBoundaryKeys(pending, ['identity', 'targetRuntimeIds'], [], `${code}_FIELDS`);
  validateReliableIdentity(pending['identity'], `${code}_IDENTITY`);
  for (const runtimeId of requireSet(pending['targetRuntimeIds'], `${code}_TARGETS`)) {
    requireString(runtimeId, `${code}_TARGET`);
  }
};

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
    'reliableIngressReceiptLedger', 'reliableIngressTerminalWatermarks',
    'receivedReliableReceiptLedger', 'receivedReliableTerminalWatermarks',
    'pendingReliableIngress', 'reliableIngressCommitting',
    'runtimeAdapterCommandFrontiers', 'pendingCommittedJOutbox', 'pendingJurisdictionImports',
    'numberedRegistrationIntents', 'certifiedRegistrationEvidence',
    'certifiedBoardNodes', 'consumptionNodes', 'accountJClaimNodes',
  ], `${code}_FIELDS`);
  for (const field of ['maxEntityInputsPerFrame', 'maxEntityTxsPerFrame']) {
    if (state[field] !== undefined) requireBoundaryInteger(state[field], `${code}_${field.toUpperCase()}`, 1);
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
  for (const field of [
    'reliableIngressReceiptLedger', 'reliableIngressTerminalWatermarks',
    'receivedReliableReceiptLedger', 'receivedReliableTerminalWatermarks',
  ]) if (state[field] !== undefined) validateStringMap(state[field], `${code}_${field.toUpperCase()}`, validateReliableReceipt);
  if (state['pendingReliableIngress'] !== undefined) validateStringMap(state['pendingReliableIngress'], `${code}_PENDING_RELIABLE_INGRESS`, validatePendingIngress);
  if (state['reliableIngressCommitting'] !== undefined) for (const key of requireSet(state['reliableIngressCommitting'], `${code}_RELIABLE_COMMITTING`)) requireString(key, `${code}_RELIABLE_COMMITTING_KEY`);
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
