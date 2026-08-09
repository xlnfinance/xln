import { normalizeJurisdictionEvent } from '../../jurisdiction/machine/event-normalization';
import { recordValidatorJHistory } from '../../jurisdiction/machine/local-history';
import type { RuntimeTx } from '../types';
import {
  requireArray,
  requireBoolean,
  requireBoundaryInteger,
  requireBoundaryRecord,
  requireExactBoundaryKeys,
  requireString,
} from '../../protocol/boundary-primitives';

type ObservationData = Extract<RuntimeTx, { type: 'observeJRange' }>['data'];

const validateDisputeEvidence = (value: unknown, code: string): void => {
  const evidence = requireBoundaryRecord(value, code);
  requireExactBoundaryKeys(evidence, [
    'sender', 'counterentity', 'initialNonce', 'finalNonce', 'initialProofbodyHash',
    'finalProofbodyHash', 'proposerIsLeft', 'leftArguments', 'rightArguments',
    'startedByLeft', 'sig',
  ], [], `${code}_FIELDS`);
  for (const field of [
    'sender', 'counterentity', 'initialNonce', 'finalNonce', 'initialProofbodyHash',
    'finalProofbodyHash', 'leftArguments', 'rightArguments', 'sig',
  ]) requireString(evidence[field], `${code}_${field.toUpperCase()}`);
  requireBoolean(evidence['proposerIsLeft'], `${code}_PROPOSER_IS_LEFT`);
  requireBoolean(evidence['startedByLeft'], `${code}_STARTED_BY_LEFT`);
};

const validateEvent = (value: unknown, code: string): void => {
  const event = requireBoundaryRecord(value, code);
  requireExactBoundaryKeys(
    event,
    ['type', 'data'],
    ['blockNumber', 'blockHash', 'transactionHash', 'logIndex', 'eventIndex'],
    `${code}_FIELDS`,
  );
  requireString(event['type'], `${code}_TYPE`);
  requireBoundaryRecord(event['data'], `${code}_DATA`);
  for (const field of ['blockNumber', 'logIndex', 'eventIndex']) {
    if (event[field] !== undefined) requireBoundaryInteger(event[field], `${code}_${field.toUpperCase()}`);
  }
  for (const field of ['blockHash', 'transactionHash']) {
    if (event[field] !== undefined) requireString(event[field], `${code}_${field.toUpperCase()}`);
  }
  if (!normalizeJurisdictionEvent(event)) throw new Error(`${code}_SEMANTIC`);
};

const validateBlock = (value: unknown, code: string): void => {
  const block = requireBoundaryRecord(value, code);
  requireExactBoundaryKeys(
    block,
    ['jurisdictionRef', 'jHeight', 'jBlockHash', 'eventsHash', 'events'],
    ['disputeFinalizationEvidence', 'disputeFinalizationEvidenceHash'],
    `${code}_FIELDS`,
  );
  requireString(block['jurisdictionRef'], `${code}_JURISDICTION`);
  requireBoundaryInteger(block['jHeight'], `${code}_HEIGHT`, 1);
  requireString(block['jBlockHash'], `${code}_BLOCK_HASH`);
  requireString(block['eventsHash'], `${code}_EVENTS_HASH`);
  requireArray(block['events'], `${code}_EVENTS`).forEach((event, index) =>
    validateEvent(event, `${code}_EVENT_${index}`));
  if (block['disputeFinalizationEvidence'] !== undefined) {
    requireArray(block['disputeFinalizationEvidence'], `${code}_EVIDENCE`).forEach((entry, index) =>
      validateDisputeEvidence(entry, `${code}_EVIDENCE_${index}`));
  }
  if (block['disputeFinalizationEvidenceHash'] !== undefined) {
    requireString(block['disputeFinalizationEvidenceHash'], `${code}_EVIDENCE_HASH`);
  }
};

function assertJObservationData(value: unknown, code: string): asserts value is ObservationData {
  const data = requireBoundaryRecord(value, code);
  requireExactBoundaryKeys(data, [
    'entityId', 'signerId', 'jurisdictionRef', 'scannedThroughHeight', 'tipBlockHash', 'blocks',
  ], ['headers'], `${code}_FIELDS`);
  for (const field of ['entityId', 'signerId', 'jurisdictionRef', 'tipBlockHash']) {
    requireString(data[field], `${code}_${field.toUpperCase()}`);
  }
  requireBoundaryInteger(data['scannedThroughHeight'], `${code}_SCANNED_HEIGHT`, 1);
  if (data['headers'] !== undefined) {
    requireArray(data['headers'], `${code}_HEADERS`).forEach((raw, index) => {
      const header = requireBoundaryRecord(raw, `${code}_HEADER_${index}`);
      requireExactBoundaryKeys(header, ['jHeight', 'jBlockHash'], [], `${code}_HEADER_${index}_FIELDS`);
      requireBoundaryInteger(header['jHeight'], `${code}_HEADER_${index}_HEIGHT`, 1);
      requireString(header['jBlockHash'], `${code}_HEADER_${index}_HASH`);
    });
  }
  requireArray(data['blocks'], `${code}_BLOCKS`).forEach((block, index) =>
    validateBlock(block, `${code}_BLOCK_${index}`));
}

export const validateJObservationData = (value: unknown, code: string): void => {
  assertJObservationData(value, code);
  // This pure reducer is the canonical semantic check for height/hash/root
  // coherence. Running it with no prior history validates every supplied byte
  // without mutating live runtime state.
  recordValidatorJHistory(undefined, value);
};
