/**
 * Boundary brands for Account transaction results.
 * These are not wire/schema fields. Constructors validate before minting.
 */

import { TOKENS } from '../../config/constants';

declare const HashlockBrand: unique symbol;
declare const HtlcSecretBrand: unique symbol;
declare const LockIdBrand: unique symbol;
declare const TokenIdBrand: unique symbol;
declare const TokenAmountBrand: unique symbol;
declare const UnixMsBrand: unique symbol;
declare const JHeightBrand: unique symbol;

export type Hashlock = string & { readonly [HashlockBrand]: typeof HashlockBrand };
export type HtlcSecret = string & { readonly [HtlcSecretBrand]: typeof HtlcSecretBrand };
export type LockId = string & { readonly [LockIdBrand]: typeof LockIdBrand };
export type TokenId = number & { readonly [TokenIdBrand]: typeof TokenIdBrand };
export type TokenAmount = bigint & { readonly [TokenAmountBrand]: typeof TokenAmountBrand };
export type UnixMs = number & { readonly [UnixMsBrand]: typeof UnixMsBrand };
export type JHeight = number & { readonly [JHeightBrand]: typeof JHeightBrand };

const HEX32 = /^0x[0-9a-fA-F]{64}$/;

export const isHashlock = (value: string): value is Hashlock => HEX32.test(value);
export const isHtlcSecret = (value: string): value is HtlcSecret => HEX32.test(value);
export const isLockId = (value: string): value is LockId =>
  typeof value === 'string' && value.length > 0 && !value.includes(':');
export const isTokenId = (value: number): value is TokenId =>
  Number.isSafeInteger(value) && value >= 0 && value <= TOKENS.MAX_TOKEN_ID;
export const isTokenAmount = (value: bigint): value is TokenAmount =>
  typeof value === 'bigint' && value >= 0n;
export const isUnixMs = (value: number): value is UnixMs =>
  Number.isSafeInteger(value) && value >= 0;
export const isJHeight = (value: number): value is JHeight =>
  Number.isSafeInteger(value) && value >= 0;

export const toHashlock = (value: string): Hashlock => {
  if (!isHashlock(value)) throw new Error(`ACCOUNT_TX_HASHLOCK_INVALID:${value}`);
  return value;
};

export const toHtlcSecret = (value: string): HtlcSecret => {
  if (!isHtlcSecret(value)) throw new Error(`ACCOUNT_TX_HTLC_SECRET_INVALID:${value}`);
  return value;
};

export const toLockId = (value: string): LockId => {
  if (!isLockId(value)) throw new Error(`ACCOUNT_TX_LOCK_ID_INVALID:${value}`);
  return value;
};

export const toTokenId = (value: number): TokenId => {
  if (!isTokenId(value)) throw new Error(`ACCOUNT_TX_TOKEN_ID_INVALID:${String(value)}`);
  return value;
};

export const toTokenAmount = (value: bigint): TokenAmount => {
  if (!isTokenAmount(value)) throw new Error(`ACCOUNT_TX_TOKEN_AMOUNT_INVALID:${value.toString()}`);
  return value;
};

export const toUnixMs = (value: number): UnixMs => {
  if (!isUnixMs(value)) throw new Error(`ACCOUNT_TX_UNIX_MS_INVALID:${String(value)}`);
  return value;
};

export const toJHeight = (value: number): JHeight => {
  if (!isJHeight(value)) throw new Error(`ACCOUNT_TX_J_HEIGHT_INVALID:${String(value)}`);
  return value;
};
