import { getAddress } from 'ethers';
import { UINT256_MAX } from '../../../../core/protocol/boundary/integer-ranges';

/** Exact host-authorization scalars shared by journey and operator funding. */
export const text = (value: unknown): string => {
  if (typeof value !== 'string' || !value) throw new Error('USDC_AUTHORITY_STRING_INVALID');
  return value;
};

export const integer = (value: unknown): number => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
    throw new Error('USDC_AUTHORITY_INTEGER_INVALID');
  return value;
};

export const hex = (value: unknown, bytes: number): string => {
  const result = text(value);
  if (!new RegExp(`^0x[0-9a-f]{${bytes * 2}}$`).test(result)) throw new Error('USDC_AUTHORITY_HEX_INVALID');
  return result;
};

export const money = (value: unknown): bigint => {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,77})$/.test(value))
    throw new Error('USDC_AUTHORITY_AMOUNT_INVALID');
  const result = BigInt(value);
  if (result > UINT256_MAX) throw new Error('USDC_AUTHORITY_AMOUNT_OUT_OF_RANGE');
  return result;
};

export const list = (value: unknown): unknown[] => {
  if (!Array.isArray(value)) throw new Error('USDC_AUTHORITY_LIST_INVALID');
  return value;
};

export const address = (value: unknown): string => getAddress(text(value)).toLowerCase();
