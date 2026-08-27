/** Boundary validators for path-keyed Merkle and Patricia node rows. */
import type { CertifiedBoardPatriciaNode } from '../../../types/entity-board-registry';
import type { AccountJClaimNode } from '../../../account/j-claims/j-claim-accumulator';
import type { PersistedPathNode } from './path-keyed-auxiliary-nodes';
import {
  requireBoundaryInteger,
  requireBoundaryRecord,
  requireExactBoundaryKeys,
  requireStorageHash,
} from '../schema-primitives';

const validatePatriciaBranch = (node: Record<string, unknown>, version: number, code: string): void => {
  requireExactBoundaryKeys(node, ['version', 'type', 'bit', 'left', 'right'], [], `${code}_FIELDS`);
  if (node['version'] !== version || node['type'] !== 'branch') throw new Error(code);
  requireBoundaryInteger(node['bit'], `${code}_BIT`);
  if (Number(node['bit']) > 255) throw new Error(`${code}_BIT`);
  requireStorageHash(node['left'], `${code}_LEFT`);
  requireStorageHash(node['right'], `${code}_RIGHT`);
};

const validateCertifiedBoardNodeValue = (value: unknown): CertifiedBoardPatriciaNode => {
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

const validateAccountJClaimNodeValue = (value: unknown): AccountJClaimNode => {
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

const validatePersistedPathNode = <TNode>(
  value: unknown,
  code: string,
  validateNode: (node: unknown) => TNode,
): PersistedPathNode<TNode> => {
  const row = requireBoundaryRecord(value, code);
  requireExactBoundaryKeys(row, ['version', 'hash', 'node'], [], `${code}_FIELDS`);
  if (row['version'] !== 1) throw new Error(`${code}_VERSION`);
  const hash = requireStorageHash(row['hash'], `${code}_HASH`);
  const node = validateNode(row['node']);
  return { version: 1, hash, node };
};

export const validatePersistedCertifiedBoardPathNode = (
  value: unknown,
): PersistedPathNode<CertifiedBoardPatriciaNode> =>
  validatePersistedPathNode(
    value,
    'STORAGE_CERTIFIED_BOARD_PATH_NODE_INVALID',
    validateCertifiedBoardNodeValue,
  );

export const validatePersistedAccountJClaimPathNode = (
  value: unknown,
): PersistedPathNode<AccountJClaimNode> =>
  validatePersistedPathNode(
    value,
    'STORAGE_ACCOUNT_J_CLAIM_PATH_NODE_INVALID',
    validateAccountJClaimNodeValue,
  );

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
