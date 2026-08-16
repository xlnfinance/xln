import type { CertifiedBoardPatriciaNode } from '../../types/entity-board-registry';
import type { ConsumptionNode } from '../../entity/consumption/consumption-accumulator';
import type { AccountJClaimNode } from '../../account/j-claims/j-claim-accumulator';
import {
  requireBoundaryInteger,
  requireBoundaryRecord,
  requireExactBoundaryKeys,
  requireStorageBigInt,
  requireStorageHash,
  requireStorageString,
} from './schema-primitives';

const validatePatriciaBranch = (node: Record<string, unknown>, version: number, code: string): void => {
  requireExactBoundaryKeys(node, ['version', 'type', 'bit', 'left', 'right'], [], `${code}_FIELDS`);
  if (node['version'] !== version || node['type'] !== 'branch') throw new Error(code);
  requireBoundaryInteger(node['bit'], `${code}_BIT`);
  if (Number(node['bit']) > 255) throw new Error(`${code}_BIT`);
  requireStorageHash(node['left'], `${code}_LEFT`);
  requireStorageHash(node['right'], `${code}_RIGHT`);
};

export const validateCertifiedBoardNodeValue = (value: unknown): CertifiedBoardPatriciaNode => {
  const code = 'STORAGE_CERTIFIED_BOARD_NODE_INVALID';
  const node = requireBoundaryRecord(value, code);
  if (node['type'] === 'branch') {
    validatePatriciaBranch(node, 1, code);
  } else {
    requireExactBoundaryKeys(node, ['version', 'type', 'key', 'record'], [], `${code}_FIELDS`);
    if (node['version'] !== 1 || node['type'] !== 'leaf') throw new Error(code);
    requireStorageHash(node['key'], `${code}_KEY`);
    validateCertifiedBoardRecord(node['record'], `${code}_RECORD`);
  }
  return node as CertifiedBoardPatriciaNode;
};

const validateCertifiedBoardRecord = (value: unknown, code: string): void => {
  const record = requireBoundaryRecord(value, code);
  requireExactBoundaryKeys(record, [
    'stackKey', 'entityId', 'boardHash', 'boardEpoch', 'previousBoardHash',
    'previousBoardValidUntil', 'activatedAtJHeight', 'logIndex', 'blockHash',
    'transactionHash', 'source',
  ], [], `${code}_FIELDS`);
  for (const key of ['stackKey', 'entityId', 'boardHash', 'previousBoardHash', 'blockHash', 'transactionHash']) {
    requireStorageHash(record[key], `${code}_${key}`);
  }
  for (const key of ['boardEpoch', 'previousBoardValidUntil', 'activatedAtJHeight', 'logIndex']) {
    requireBoundaryInteger(record[key], `${code}_${key}`);
  }
  if (!['FoundationBootstrapped', 'EntityRegistered', 'BoardActivated'].includes(String(record['source']))) {
    throw new Error(`${code}_SOURCE`);
  }
};

export const validateConsumptionNodeValue = (value: unknown): ConsumptionNode => {
  const code = 'STORAGE_CONSUMPTION_NODE_INVALID';
  const node = requireBoundaryRecord(value, code);
  if (node['type'] === 'branch') validatePatriciaBranch(node, 1, code);
  else {
    requireExactBoundaryKeys(node, ['version', 'type', 'key', 'value'], [], `${code}_FIELDS`);
    if (node['version'] !== 1 || node['type'] !== 'leaf') throw new Error(code);
    requireStorageHash(node['key'], `${code}_KEY`);
    validateConsumptionFrontier(node['value'], `${code}_VALUE`);
  }
  return node as ConsumptionNode;
};

const validateConsumptionFrontier = (value: unknown, code: string): void => {
  const frontier = requireBoundaryRecord(value, code);
  requireExactBoundaryKeys(frontier, [
    'version', 'lastContiguousSeq', 'lastSemanticHash', 'count', 'lastOutputHash', 'lastOutputHanko',
  ], ['quarantine'], `${code}_FIELDS`);
  if (frontier['version'] !== 1) throw new Error(`${code}_VERSION`);
  requireStorageBigInt(frontier['lastContiguousSeq'], `${code}_SEQUENCE`, 1n);
  requireStorageHash(frontier['lastSemanticHash'], `${code}_SEMANTIC_HASH`);
  requireStorageBigInt(frontier['count'], `${code}_COUNT`, 1n);
  requireStorageHash(frontier['lastOutputHash'], `${code}_OUTPUT_HASH`);
  requireStorageString(frontier['lastOutputHanko'], `${code}_OUTPUT_HANKO`);
  if (frontier['quarantine'] !== undefined) validateQuarantine(frontier['quarantine'], `${code}_QUARANTINE`);
};

const validateQuarantine = (value: unknown, code: string): void => {
  const evidence = requireBoundaryRecord(value, code);
  requireExactBoundaryKeys(evidence, [
    'sequence', 'conflictingSemanticHash', 'conflictingOutputHash', 'conflictingOutputHanko',
  ], [], `${code}_FIELDS`);
  requireStorageBigInt(evidence['sequence'], `${code}_SEQUENCE`, 1n);
  requireStorageHash(evidence['conflictingSemanticHash'], `${code}_SEMANTIC_HASH`);
  requireStorageHash(evidence['conflictingOutputHash'], `${code}_OUTPUT_HASH`);
  requireStorageString(evidence['conflictingOutputHanko'], `${code}_OUTPUT_HANKO`);
};

export const validateAccountJClaimNodeValue = (value: unknown): AccountJClaimNode => {
  const code = 'STORAGE_ACCOUNT_J_CLAIM_NODE_INVALID';
  const node = requireBoundaryRecord(value, code);
  if (node['type'] === 'branch') validatePatriciaBranch(node, 1, code);
  else {
    requireExactBoundaryKeys(node, ['version', 'type', 'key', 'record'], [], `${code}_FIELDS`);
    if (node['version'] !== 1 || node['type'] !== 'leaf') throw new Error(code);
    requireStorageHash(node['key'], `${code}_KEY`);
    validateAccountJClaimRecord(node['record'], `${code}_RECORD`);
  }
  return node as AccountJClaimNode;
};

const validateAccountJClaimRecord = (value: unknown, code: string): void => {
  const record = requireBoundaryRecord(value, code);
  requireExactBoundaryKeys(record, [
    'version', 'accountKey', 'side', 'jHeight', 'jBlockHash', 'eventsHash',
  ], [], `${code}_FIELDS`);
  if (record['version'] !== 1) throw new Error(`${code}_VERSION`);
  requireStorageHash(record['accountKey'], `${code}_ACCOUNT_KEY`);
  if (record['side'] !== 'left' && record['side'] !== 'right') throw new Error(`${code}_SIDE`);
  requireBoundaryInteger(record['jHeight'], `${code}_HEIGHT`);
  requireStorageHash(record['jBlockHash'], `${code}_BLOCK_HASH`);
  requireStorageHash(record['eventsHash'], `${code}_EVENTS_HASH`);
};
