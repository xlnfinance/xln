import { ethers } from 'ethers';

import type {
  AccountJClaimBranchNode,
  AccountJClaimDomain,
  AccountJClaimNode,
  AccountJClaimRecord,
  AccountJClaimSide,
} from '../types/account-j-claims';

const ABI = ethers.AbiCoder.defaultAbiCoder();
const domain = (label: string): string => ethers.keccak256(ethers.toUtf8Bytes(label)).toLowerCase();
const ACCOUNT_DOMAIN = domain('xln.account-j-claim.account.v1');
const KEY_DOMAIN = domain('xln.account-j-claim.key.v1');
const RECORD_DOMAIN = domain('xln.account-j-claim.record.v1');
const LEAF_DOMAIN = domain('xln.account-j-claim.leaf.v1');
const BRANCH_DOMAIN = domain('xln.account-j-claim.branch.v1');
export const EMPTY_ACCOUNT_J_CLAIM_ROOT = domain('xln.account-j-claim.empty.v1');
const UINT64_MAX = (1n << 64n) - 1n;

const recordObject = (value: unknown, label: string): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label}_INVALID`);
  return value as Record<string, unknown>;
};

const exactKeys = (value: Record<string, unknown>, expected: readonly string[], label: string): void => {
  const actual = Object.keys(value).sort();
  const canonical = [...expected].sort();
  if (actual.length !== canonical.length || actual.some((key, index) => key !== canonical[index])) {
    throw new Error(`${label}_FIELDS_INVALID:${actual.join(',')}`);
  }
};

export const normalizeAccountJBytes32 = (value: unknown, label: string): string => {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!/^0x[0-9a-f]{64}$/.test(normalized)) throw new Error(`ACCOUNT_J_CLAIM_${label}_INVALID:${normalized || 'missing'}`);
  return normalized;
};

const normalizeAddress = (value: unknown): string => {
  try {
    return ethers.getAddress(String(value ?? '')).toLowerCase();
  } catch {
    throw new Error(`ACCOUNT_J_CLAIM_DEPOSITORY_INVALID:${String(value ?? '')}`);
  }
};

const normalizeHeight = (value: unknown): number => {
  const height = Number(value);
  if (!Number.isSafeInteger(height) || height < 1 || BigInt(height) > UINT64_MAX) {
    throw new Error(`ACCOUNT_J_CLAIM_HEIGHT_INVALID:${String(value)}`);
  }
  return height;
};

const normalizeSide = (value: unknown): AccountJClaimSide => {
  if (value !== 'left' && value !== 'right') throw new Error(`ACCOUNT_J_CLAIM_SIDE_INVALID:${String(value)}`);
  return value;
};

export const getAccountJClaimAccountKey = (value: AccountJClaimDomain): string => {
  const chainId = Number(value.chainId);
  if (!Number.isSafeInteger(chainId) || chainId <= 0) {
    throw new Error(`ACCOUNT_J_CLAIM_CHAIN_INVALID:${String(value.chainId)}`);
  }
  const left = normalizeAccountJBytes32(value.leftEntity, 'LEFT_ENTITY');
  const right = normalizeAccountJBytes32(value.rightEntity, 'RIGHT_ENTITY');
  if (left >= right) throw new Error(`ACCOUNT_J_CLAIM_ENTITY_ORDER_INVALID:${left}:${right}`);
  return ethers.keccak256(ABI.encode(
    ['bytes32', 'uint256', 'address', 'bytes32', 'bytes32'],
    [ACCOUNT_DOMAIN, chainId, normalizeAddress(value.depositoryAddress), left, right],
  )).toLowerCase();
};

export const createAccountJClaimRecord = (
  domainValue: AccountJClaimDomain,
  sideValue: AccountJClaimSide,
  value: Pick<AccountJClaimRecord, 'jHeight' | 'jBlockHash' | 'eventsHash'>,
): AccountJClaimRecord => Object.freeze({
  version: 1,
  accountKey: getAccountJClaimAccountKey(domainValue),
  side: normalizeSide(sideValue),
  jHeight: normalizeHeight(value.jHeight),
  jBlockHash: normalizeAccountJBytes32(value.jBlockHash, 'BLOCK_HASH'),
  eventsHash: normalizeAccountJBytes32(value.eventsHash, 'EVENTS_HASH'),
});

export const parseAccountJClaimRecord = (value: unknown): AccountJClaimRecord => {
  const source = recordObject(value, 'ACCOUNT_J_CLAIM_RECORD');
  exactKeys(source, ['version', 'accountKey', 'side', 'jHeight', 'jBlockHash', 'eventsHash'], 'ACCOUNT_J_CLAIM_RECORD');
  if (source['version'] !== 1) throw new Error(`ACCOUNT_J_CLAIM_RECORD_VERSION_INVALID:${String(source['version'])}`);
  return Object.freeze({
    version: 1,
    accountKey: normalizeAccountJBytes32(source['accountKey'], 'ACCOUNT_KEY'),
    side: normalizeSide(source['side']),
    jHeight: normalizeHeight(source['jHeight']),
    jBlockHash: normalizeAccountJBytes32(source['jBlockHash'], 'BLOCK_HASH'),
    eventsHash: normalizeAccountJBytes32(source['eventsHash'], 'EVENTS_HASH'),
  });
};

export const getAccountJClaimKey = (value: AccountJClaimRecord): string => {
  const record = parseAccountJClaimRecord(value);
  return ethers.keccak256(ABI.encode(
    ['bytes32', 'bytes32', 'uint8', 'uint64'],
    [KEY_DOMAIN, record.accountKey, record.side === 'left' ? 0 : 1, record.jHeight],
  )).toLowerCase();
};

const hashRecord = (recordValue: AccountJClaimRecord): string => {
  const value = parseAccountJClaimRecord(recordValue);
  return ethers.keccak256(ABI.encode(
    ['bytes32', 'bytes32', 'uint8', 'uint64', 'bytes32', 'bytes32'],
    [RECORD_DOMAIN, value.accountKey, value.side === 'left' ? 0 : 1, value.jHeight, value.jBlockHash, value.eventsHash],
  )).toLowerCase();
};

export const parseAccountJClaimNode = (value: unknown): AccountJClaimNode => {
  const source = recordObject(value, 'ACCOUNT_J_CLAIM_NODE');
  if (source['version'] !== 1) throw new Error(`ACCOUNT_J_CLAIM_NODE_VERSION_INVALID:${String(source['version'])}`);
  if (source['type'] === 'leaf') {
    exactKeys(source, ['version', 'type', 'key', 'record'], 'ACCOUNT_J_CLAIM_LEAF');
    const record = parseAccountJClaimRecord(source['record']);
    const key = normalizeAccountJBytes32(source['key'], 'LEAF_KEY');
    const expected = getAccountJClaimKey(record);
    if (key !== expected) throw new Error(`ACCOUNT_J_CLAIM_LEAF_KEY_MISMATCH:${key}:${expected}`);
    return Object.freeze({ version: 1, type: 'leaf', key, record });
  }
  if (source['type'] !== 'branch') throw new Error(`ACCOUNT_J_CLAIM_NODE_TYPE_INVALID:${String(source['type'])}`);
  exactKeys(source, ['version', 'type', 'bit', 'left', 'right'], 'ACCOUNT_J_CLAIM_BRANCH');
  const bit = Number(source['bit']);
  if (!Number.isInteger(bit) || bit < 0 || bit > 255) throw new Error(`ACCOUNT_J_CLAIM_BRANCH_BIT_INVALID:${String(source['bit'])}`);
  const left = normalizeAccountJBytes32(source['left'], 'BRANCH_LEFT');
  const right = normalizeAccountJBytes32(source['right'], 'BRANCH_RIGHT');
  if (left === right) throw new Error(`ACCOUNT_J_CLAIM_BRANCH_UNARY:${left}`);
  return Object.freeze({ version: 1, type: 'branch', bit, left, right });
};

export const hashAccountJClaimNode = (nodeValue: AccountJClaimNode): string => {
  const node = parseAccountJClaimNode(nodeValue);
  if (node.type === 'leaf') {
    return ethers.keccak256(ABI.encode(
      ['bytes32', 'uint8', 'bytes32', 'bytes32'],
      [LEAF_DOMAIN, 1, node.key, hashRecord(node.record)],
    )).toLowerCase();
  }
  return ethers.keccak256(ABI.encode(
    ['bytes32', 'uint8', 'uint16', 'bytes32', 'bytes32'],
    [BRANCH_DOMAIN, 1, node.bit, node.left, node.right],
  )).toLowerCase();
};

export const accountJClaimKeyBit = (key: string, bit: number): 0 | 1 => {
  const offset = 2 + Math.floor(bit / 8) * 2;
  const byte = Number.parseInt(key.slice(offset, offset + 2), 16);
  return ((byte >> (7 - (bit % 8))) & 1) as 0 | 1;
};

export const firstDifferentAccountJClaimBit = (left: string, right: string): number => {
  for (let bit = 0; bit < 256; bit += 1) {
    if (accountJClaimKeyBit(left, bit) !== accountJClaimKeyBit(right, bit)) return bit;
  }
  return -1;
};

export type AccountJClaimProofPath = Array<Readonly<{
  hash: string;
  node: AccountJClaimBranchNode;
  direction: 0 | 1;
}>>;
