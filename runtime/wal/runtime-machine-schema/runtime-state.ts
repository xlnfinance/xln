import { validateAccountFrame } from '../../validation-utils';
import { validateJInputs } from './j';
import {
  validateNumberedRecord,
  validatePendingImport,
  validateRegistrationEvidence,
} from './registrations';
import {
  requireArray,
  requireBoolean,
  requireBoundaryInteger,
  requireBoundaryRecord,
  requireExactBoundaryKeys,
  requireMap,
  requireSet,
  requireString,
  requireStringArray,
  validateStorageSafeValue,
  validateStringMap,
} from './primitives';

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
  if (body['version'] !== 2) throw new Error(`${code}_BODY_VERSION`);
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

const validateAccountFrameRecord = (value: unknown, code: string): void => {
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
  validateAccountFrame(frame, code);
  if (record['runtimeHeight'] !== undefined) requireBoundaryInteger(record['runtimeHeight'], `${code}_RUNTIME_HEIGHT`);
  if (record['timestamp'] !== undefined) requireBoundaryInteger(record['timestamp'], `${code}_TIMESTAMP`);
};

const validateQuarantine = (value: unknown, code: string): void => {
  const item = requireBoundaryRecord(value, code);
  requireExactBoundaryKeys(item, [
    'id', 'height', 'timestamp', 'reason', 'message', 'action', 'counts',
    'entityInputs', 'runtimeTxTypes', 'jInputs',
  ], [], `${code}_FIELDS`);
  for (const field of ['id', 'reason', 'message']) requireString(item[field], `${code}_${field.toUpperCase()}`);
  requireBoundaryInteger(item['height'], `${code}_HEIGHT`);
  requireBoundaryInteger(item['timestamp'], `${code}_TIMESTAMP`);
  if (item['action'] !== 'dropped') throw new Error(`${code}_ACTION`);
  const counts = requireBoundaryRecord(item['counts'], `${code}_COUNTS`);
  requireExactBoundaryKeys(counts, ['runtimeTxs', 'entityInputs', 'jInputs'], [], `${code}_COUNTS_FIELDS`);
  for (const field of ['runtimeTxs', 'entityInputs', 'jInputs']) requireBoundaryInteger(counts[field], `${code}_COUNT_${field}`);
  for (const [index, raw] of requireArray(item['entityInputs'], `${code}_ENTITY_INPUTS`).entries()) {
    const input = requireBoundaryRecord(raw, `${code}_ENTITY_INPUT_${index}`);
    requireExactBoundaryKeys(input, ['entityId', 'signerId', 'txTypes'], [], `${code}_ENTITY_INPUT_${index}_FIELDS`);
    requireString(input['entityId'], `${code}_ENTITY_INPUT_${index}_ENTITY`);
    requireString(input['signerId'], `${code}_ENTITY_INPUT_${index}_SIGNER`);
    requireStringArray(input['txTypes'], `${code}_ENTITY_INPUT_${index}_TX_TYPES`);
  }
  requireStringArray(item['runtimeTxTypes'], `${code}_RUNTIME_TX_TYPES`);
  for (const [index, raw] of requireArray(item['jInputs'], `${code}_J_INPUTS`).entries()) {
    const input = requireBoundaryRecord(raw, `${code}_J_INPUT_${index}`);
    requireExactBoundaryKeys(input, ['jurisdictionName', 'jTxCount'], [], `${code}_J_INPUT_${index}_FIELDS`);
    requireString(input['jurisdictionName'], `${code}_J_INPUT_${index}_JURISDICTION`);
    requireBoundaryInteger(input['jTxCount'], `${code}_J_INPUT_${index}_COUNT`);
  }
};

const validateSecurityIncident = (value: unknown, code: string): void => {
  const incident = requireBoundaryRecord(value, code);
  requireExactBoundaryKeys(incident, [
    'id', 'domain', 'code', 'source', 'severity', 'status', 'summary', 'entityId',
    'firstSeenAt', 'lastSeenAt', 'occurrences',
  ], ['accountId', 'offerId', 'routeHash', 'resolvedAt'], `${code}_FIELDS`);
  for (const field of ['id', 'code', 'summary', 'entityId']) {
    requireString(incident[field], `${code}_${field.toUpperCase()}`);
  }
  for (const field of ['accountId', 'offerId', 'routeHash']) {
    if (incident[field] !== undefined) requireString(incident[field], `${code}_${field.toUpperCase()}`);
  }
  if (incident['domain'] !== 'cross-j') throw new Error(`${code}_DOMAIN`);
  if (incident['source'] !== 'local-consensus' && incident['source'] !== 'remote-ingress') {
    throw new Error(`${code}_SOURCE`);
  }
  if (incident['severity'] !== 'warning' && incident['severity'] !== 'critical') {
    throw new Error(`${code}_SEVERITY`);
  }
  if (incident['status'] !== 'active' && incident['status'] !== 'resolved') {
    throw new Error(`${code}_STATUS`);
  }
  requireBoundaryInteger(incident['firstSeenAt'], `${code}_FIRST_SEEN`);
  requireBoundaryInteger(incident['lastSeenAt'], `${code}_LAST_SEEN`);
  requireBoundaryInteger(incident['occurrences'], `${code}_OCCURRENCES`, 1);
  if (incident['resolvedAt'] !== undefined) requireBoundaryInteger(incident['resolvedAt'], `${code}_RESOLVED_AT`);
};

export const validateDurableRuntimeState = (value: unknown, code: string): void => {
  const state = requireBoundaryRecord(value, code);
  requireExactBoundaryKeys(state, [], [
    'halted', 'fatalDebugPayload', 'maxEntityInputsPerFrame', 'maxEntityTxsPerFrame',
    'pendingAuditEvents', 'securityIncidents', 'quarantinedRuntimeInputs', 'pendingFrameDbRecords', 'deferredNetworkMeta',
    'reliableIngressReceiptLedger', 'reliableIngressTerminalWatermarks',
    'receivedReliableReceiptLedger', 'receivedReliableTerminalWatermarks',
    'pendingReliableIngress', 'reliableIngressCommitting',
    'runtimeAdapterCommandFrontiers', 'pendingCommittedJOutbox', 'pendingJurisdictionImports',
    'numberedRegistrationIntents', 'certifiedRegistrationEvidence',
  ], `${code}_FIELDS`);
  if (state['halted'] !== undefined) requireBoolean(state['halted'], `${code}_HALTED`);
  if (state['fatalDebugPayload'] !== undefined) {
    const fatal = requireBoundaryRecord(state['fatalDebugPayload'], `${code}_FATAL`);
    requireExactBoundaryKeys(fatal, ['message'], ['stack', 'height', 'timestamp'], `${code}_FATAL_FIELDS`);
    requireString(fatal['message'], `${code}_FATAL_MESSAGE`);
    if (fatal['stack'] !== undefined) requireString(fatal['stack'], `${code}_FATAL_STACK`);
    if (fatal['height'] !== undefined) requireBoundaryInteger(fatal['height'], `${code}_FATAL_HEIGHT`);
    if (fatal['timestamp'] !== undefined) requireBoundaryInteger(fatal['timestamp'], `${code}_FATAL_TIMESTAMP`);
  }
  for (const field of ['maxEntityInputsPerFrame', 'maxEntityTxsPerFrame']) {
    if (state[field] !== undefined) requireBoundaryInteger(state[field], `${code}_${field.toUpperCase()}`, 1);
  }
  if (state['pendingAuditEvents'] !== undefined) {
    requireArray(state['pendingAuditEvents'], `${code}_PENDING_AUDIT_EVENTS`).forEach((event, index) => {
      requireBoundaryRecord(event, `${code}_PENDING_AUDIT_EVENT_${index}`);
      validateStorageSafeValue(event, `${code}_PENDING_AUDIT_EVENT_${index}`);
    });
  }
  if (state['securityIncidents'] !== undefined) {
    const incidents = requireMap(state['securityIncidents'], `${code}_SECURITY_INCIDENTS`);
    if (incidents.size > 256) throw new Error(`${code}_SECURITY_INCIDENTS_CAPACITY`);
    for (const [rawId, incident] of incidents) {
      const id = requireString(rawId, `${code}_SECURITY_INCIDENT_ID`);
      validateSecurityIncident(incident, `${code}_SECURITY_INCIDENT_${id}`);
      const stored = requireBoundaryRecord(incident, `${code}_SECURITY_INCIDENT_${id}`);
      if (stored['id'] !== id) throw new Error(`${code}_SECURITY_INCIDENT_KEY_MISMATCH`);
    }
  }
  if (state['quarantinedRuntimeInputs'] !== undefined) requireArray(state['quarantinedRuntimeInputs'], `${code}_QUARANTINE`).forEach((entry, index) => validateQuarantine(entry, `${code}_QUARANTINE_${index}`));
  if (state['pendingFrameDbRecords'] !== undefined) requireArray(state['pendingFrameDbRecords'], `${code}_FRAME_DB`).forEach((entry, index) => validateAccountFrameRecord(entry, `${code}_FRAME_DB_${index}`));
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
};
