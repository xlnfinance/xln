import type { CertifiedBoardPatriciaNode } from '../types/entity-board-registry';
import type { ConsumptionNode } from '../entity/consumption-accumulator';
import type { AccountJClaimNode } from '../account/j-claim-accumulator';
import type {
  StorageMerkleBranchDoc,
  StorageMerkleLeafDoc,
  StorageMerkleRootDoc,
} from './types';
import {
  requireBoundaryInteger,
  requireBoundaryRecord,
  requireExactBoundaryKeys,
  requireStorageArray,
  requireStorageBigInt,
  requireStorageHash,
  requireStorageHex,
  requireStoragePath,
  requireStorageRadix,
  requireStorageString,
} from './schema-primitives';

const NAMESPACES = new Set([
  'runtime-roots', 'entity-core', 'accounts', 'books', 'lock-book',
  'account-deltas', 'account-locks', 'account-swap-offers', 'htlc-routes',
]);

const merklePathSlots = (radix: 16 | 256): number => radix === 16 ? 66 : 33;

const requireMerklePath = (
  value: unknown,
  radix: 16 | 256,
  kind: 'branch' | 'leaf' | 'root',
  code: string,
): number[] => {
  const path = requireStoragePath(value, radix, code);
  const fullLength = merklePathSlots(radix);
  if (kind === 'leaf' ? path.length !== fullLength : path.length >= fullLength) throw new Error(code);
  return path;
};

const requireNamespace = (value: unknown, code: string): StorageMerkleRootDoc['namespace'] => {
  if (!NAMESPACES.has(String(value))) throw new Error(code);
  return value as StorageMerkleRootDoc['namespace'];
};

export const validateStorageMerkleRootDocValue = (value: unknown): StorageMerkleRootDoc => {
  const code = 'STORAGE_MERKLE_ROOT_INVALID';
  const root = requireBoundaryRecord(value, code);
  requireExactBoundaryKeys(root, [
    'entityId', 'namespace', 'radix', 'rootHash', 'rootKind', 'rootPath', 'leafCount',
  ], [], `${code}_FIELDS`);
  requireStorageString(root['entityId'], `${code}_ENTITY_ID`);
  requireNamespace(root['namespace'], `${code}_NAMESPACE`);
  const radix = requireStorageRadix(root['radix'], `${code}_RADIX`);
  requireStorageHash(root['rootHash'], `${code}_HASH`);
  if (!['empty', 'branch', 'leaf'].includes(String(root['rootKind']))) throw new Error(`${code}_KIND`);
  const rootKind = String(root['rootKind']) as StorageMerkleRootDoc['rootKind'];
  if (rootKind === 'empty') {
    if (requireStoragePath(root['rootPath'], radix, `${code}_PATH`).length !== 0) throw new Error(`${code}_PATH`);
  } else {
    requireMerklePath(root['rootPath'], radix, rootKind, `${code}_PATH`);
  }
  const leafCount = requireBoundaryInteger(root['leafCount'], `${code}_LEAF_COUNT`);
  if (leafCount < 0 || (rootKind === 'empty' ? leafCount !== 0 : leafCount === 0)) {
    throw new Error(`${code}_LEAF_COUNT`);
  }
  return root as StorageMerkleRootDoc;
};

export const validateStorageMerkleBranchDocValue = (value: unknown): StorageMerkleBranchDoc => {
  const code = 'STORAGE_MERKLE_BRANCH_INVALID';
  const branch = requireBoundaryRecord(value, code);
  requireExactBoundaryKeys(branch, [
    'entityId', 'namespace', 'radix', 'path', 'hash', 'children',
  ], [], `${code}_FIELDS`);
  requireStorageString(branch['entityId'], `${code}_ENTITY_ID`);
  requireNamespace(branch['namespace'], `${code}_NAMESPACE`);
  const radix = requireStorageRadix(branch['radix'], `${code}_RADIX`);
  const path = requireMerklePath(branch['path'], radix, 'branch', `${code}_PATH`);
  requireStorageHash(branch['hash'], `${code}_HASH`);
  const children = requireStorageArray(branch['children'], `${code}_CHILDREN`);
  if (children.length < 2 || children.length > radix) throw new Error(`${code}_CHILDREN`);
  const slots = new Set<number>();
  for (const [index, raw] of children.entries()) {
    const slot = validateMerkleChild(raw, radix, path, `${code}_CHILD_${index}`);
    if (slots.has(slot)) throw new Error(`${code}_CHILD_SLOT_DUPLICATE`);
    slots.add(slot);
  }
  return branch as StorageMerkleBranchDoc;
};

const validateMerkleChild = (value: unknown, radix: 16 | 256, parentPath: number[], code: string): number => {
  const child = requireBoundaryRecord(value, code);
  requireExactBoundaryKeys(child, ['slot', 'kind', 'path', 'hash'], [], `${code}_FIELDS`);
  const slot = requireBoundaryInteger(child['slot'], `${code}_SLOT`);
  if (slot < 0 || slot >= radix) throw new Error(`${code}_SLOT`);
  if (child['kind'] !== 'branch' && child['kind'] !== 'leaf') throw new Error(`${code}_KIND`);
  const path = requireMerklePath(child['path'], radix, child['kind'], `${code}_PATH`);
  if (path.length <= parentPath.length || path[parentPath.length] !== slot) throw new Error(`${code}_PATH`);
  for (const [index, parentSlot] of parentPath.entries()) {
    if (path[index] !== parentSlot) throw new Error(`${code}_PATH`);
  }
  requireStorageHash(child['hash'], `${code}_HASH`);
  return slot;
};

export const validateStorageMerkleLeafDocValue = (value: unknown): StorageMerkleLeafDoc => {
  const code = 'STORAGE_MERKLE_LEAF_INVALID';
  const leaf = requireBoundaryRecord(value, code);
  requireExactBoundaryKeys(leaf, [
    'entityId', 'namespace', 'radix', 'path', 'key', 'valueHash', 'hash',
  ], [], `${code}_FIELDS`);
  requireStorageString(leaf['entityId'], `${code}_ENTITY_ID`);
  requireNamespace(leaf['namespace'], `${code}_NAMESPACE`);
  const radix = requireStorageRadix(leaf['radix'], `${code}_RADIX`);
  requireMerklePath(leaf['path'], radix, 'leaf', `${code}_PATH`);
  requireStorageHex(leaf['key'], `${code}_KEY`);
  requireStorageHash(leaf['valueHash'], `${code}_VALUE_HASH`);
  requireStorageHash(leaf['hash'], `${code}_HASH`);
  return leaf as StorageMerkleLeafDoc;
};

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
  if (node['type'] === 'branch') validatePatriciaBranch(node, 2, code);
  else {
    requireExactBoundaryKeys(node, ['version', 'type', 'key', 'value'], [], `${code}_FIELDS`);
    if (node['version'] !== 2 || node['type'] !== 'leaf') throw new Error(code);
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
