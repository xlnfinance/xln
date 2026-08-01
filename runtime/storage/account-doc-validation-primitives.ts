import { canonicalAccountTxForFrameHash } from '../account/consensus/frame';
import { assertAccountFrameDeltaIntegrity } from '../account/frame';
import { computeCanonicalMerkleRoot } from '../account/state-root';
import { LIMITS, TOKENS } from '../config/constants';
import type { AccountFrame, Delta } from '../types/account';
import {
  requireBoundaryInteger,
  requireBoundaryRecord,
  requireExactBoundaryKeys,
  requireStorageArray,
  requireStorageMap,
} from './schema-primitives';

export const UINT256_MAX = (1n << 256n) - 1n;
const INT256_MIN = -(1n << 255n);
const INT256_MAX = (1n << 255n) - 1n;
const DELTA_FIELDS = [
  'tokenId', 'collateral', 'ondelta', 'offdelta', 'leftCreditLimit',
  'rightCreditLimit', 'leftAllowance', 'rightAllowance', 'leftHold', 'rightHold',
] as const;

export const shape = <T extends Record<string, unknown> = Record<string, unknown>>(value: unknown, required: readonly string[], optional: readonly string[], code: string): T => {
  const record = requireBoundaryRecord(value, code);
  requireExactBoundaryKeys(record, required, optional, `${code}_FIELDS`);
  return record as T;
};
export const boundedArray = (value: unknown, maximum: number, code: string): unknown[] => {
  const array = requireStorageArray(value, code);
  if (array.length > maximum) throw new Error(`${code}_LIMIT`);
  return array;
};
export const boundedMap = (value: unknown, maximum: number, code: string): Map<unknown, unknown> => {
  const map = requireStorageMap(value, code);
  if (map.size > maximum) throw new Error(`${code}_LIMIT`);
  return map;
};
export const uint = (value: unknown, code: string, maximum = Number.MAX_SAFE_INTEGER): number => {
  const parsed = requireBoundaryInteger(value, code);
  if (parsed > maximum) throw new Error(`${code}_MAX`);
  return parsed;
};
export const integer = (value: unknown, minimum: bigint, maximum: bigint, code: string): bigint => {
  if (typeof value !== 'bigint' || value < minimum || value > maximum) throw new Error(code);
  return value;
};
export const uint256 = (value: unknown, code: string): bigint => integer(value, 0n, UINT256_MAX, code);
export const int256 = (value: unknown, code: string): bigint => integer(value, INT256_MIN, INT256_MAX, code);
export const text = (value: unknown, code: string, maximum?: number): string => {
  if (
    typeof value !== 'string'
    || value.length === 0
    || (maximum !== undefined && value.length > maximum)
  ) throw new Error(code);
  return value;
};
export const bytes = (value: unknown, size: number, code: string): string => {
  const encoded = text(value, code, 2 + size * 2);
  if (!new RegExp(`^0x[0-9a-f]{${size * 2}}$`).test(encoded)) throw new Error(code);
  return encoded;
};
export const hex = (value: unknown, code: string): string => {
  const encoded = text(value, code, LIMITS.MAX_FRAME_SIZE_BYTES * 2 + 2);
  if (!/^0x(?:[0-9a-f]{2})*$/.test(encoded)) throw new Error(code);
  return encoded;
};
export const flag = (value: unknown, code: string): boolean => {
  if (typeof value !== 'boolean') throw new Error(code);
  return value;
};
export const token = (value: unknown, code: string): number => uint(value, code, TOKENS.MAX_TOKEN_ID);

export const validateDelta = (value: unknown, code: string): Delta => {
  const delta = shape<Delta & Record<string, unknown>>(value, DELTA_FIELDS, [], code);
  token(delta['tokenId'], `${code}_TOKEN`);
  for (const field of ['collateral', 'leftCreditLimit', 'rightCreditLimit', 'leftAllowance', 'rightAllowance', 'leftHold', 'rightHold']) {
    uint256(delta[field], `${code}_${field}`);
  }
  int256(delta['ondelta'], `${code}_ONDELTA`);
  int256(delta['offdelta'], `${code}_OFFDELTA`);
  return delta;
};

export const computeStorageAccountFrameHash = (frame: AccountFrame): string => computeCanonicalMerkleRoot('account.frame', [
  ['transition', {
    height: frame.height, timestamp: frame.timestamp, jHeight: frame.jHeight,
    prevFrameHash: frame.prevFrameHash, byLeft: frame.byLeft,
  }],
  ['transactions', frame.accountTxs.map(canonicalAccountTxForFrameHash)],
  ['deltas', frame.deltas],
  ['accountStateRoot', frame.accountStateRoot],
], 'integrity');

export const validateFrame = (value: unknown, code: string): AccountFrame => {
  const frame = shape<AccountFrame & Record<string, unknown>>(value, [
    'height', 'timestamp', 'jHeight', 'accountTxs', 'prevFrameHash',
    'accountStateRoot', 'stateHash', 'deltas', 'byLeft',
  ], [], code);
  const height = uint(frame['height'], `${code}_HEIGHT`);
  uint(frame['timestamp'], `${code}_TIMESTAMP`);
  uint(frame['jHeight'], `${code}_J_HEIGHT`);
  boundedArray(frame['accountTxs'], LIMITS.ACCOUNT_MEMPOOL_SIZE, `${code}_TXS`);
  const prev = frame['prevFrameHash'];
  if (prev !== (height === 0 ? '' : height === 1 ? 'genesis' : bytes(prev, 32, `${code}_PREV`))) {
    throw new Error(`${code}_PREV`);
  }
  bytes(frame['accountStateRoot'], 32, `${code}_STATE_ROOT`);
  flag(frame['byLeft'], `${code}_BY_LEFT`);
  const deltas = boundedArray(frame['deltas'], LIMITS.MAX_ACCOUNT_TOKEN_ROWS, `${code}_DELTAS`)
    .map((delta, index) => validateDelta(delta, `${code}_DELTA_${index}`));
  const decoded: AccountFrame = { ...frame, deltas };
  assertAccountFrameDeltaIntegrity(decoded, code);
  if (height === 0) {
    if (frame['stateHash'] !== '') throw new Error(`${code}_GENESIS_HASH`);
  } else if (bytes(frame['stateHash'], 32, `${code}_HASH`) !== computeStorageAccountFrameHash(decoded)) {
    throw new Error(`${code}_HASH_MISMATCH`);
  }
  return decoded;
};
