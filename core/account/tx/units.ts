/**
 * Boundary brands for token metadata and Account transaction results.
 * These are not wire/schema fields. Constructors validate before minting.
 */

declare const HashlockBrand: unique symbol;
declare const HtlcSecretBrand: unique symbol;
declare const TokenDecimalsBrand: unique symbol;
declare const TokenAmountBrand: unique symbol;

export type Hashlock = string & { readonly [HashlockBrand]: typeof HashlockBrand };
export type HtlcSecret = string & { readonly [HtlcSecretBrand]: typeof HtlcSecretBrand };
export type TokenDecimals = number & { readonly [TokenDecimalsBrand]: typeof TokenDecimalsBrand };
export type TokenAmount = bigint & { readonly [TokenAmountBrand]: typeof TokenAmountBrand };

const HEX32 = /^0x[0-9a-fA-F]{64}$/;

const isHashlock = (value: string): value is Hashlock => HEX32.test(value);
const isHtlcSecret = (value: string): value is HtlcSecret => HEX32.test(value);
const isTokenAmount = (value: bigint): value is TokenAmount => typeof value === 'bigint' && value >= 0n;

export const toHashlock = (value: string): Hashlock => {
  if (!isHashlock(value)) throw new Error(`ACCOUNT_TX_HASHLOCK_INVALID:${value}`);
  return value;
};

export const toHtlcSecret = (value: string): HtlcSecret => {
  if (!isHtlcSecret(value)) throw new Error(`ACCOUNT_TX_HTLC_SECRET_INVALID:${value}`);
  return value;
};

export const toTokenAmount = (value: bigint): TokenAmount => {
  if (!isTokenAmount(value)) throw new Error(`ACCOUNT_TX_TOKEN_AMOUNT_INVALID:${value.toString()}`);
  return value;
};

const isTokenDecimals = (value: number): value is TokenDecimals =>
  Number.isSafeInteger(value) && value >= 0 && value <= 255;

export const asTokenDecimals = (value: number): TokenDecimals => {
  if (!isTokenDecimals(value)) throw new Error(`TOKEN_DECIMALS_INVALID:${String(value)}`);
  return value;
};
