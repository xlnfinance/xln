import type { Delta } from '../../types/account';
import { LIMITS } from '../../config/constants';

export const ACCOUNT_DELTA_ERROR_CODES = {
  tokenInvalid: 'ACCOUNT_DELTA_TOKEN_INVALID',
  rowCountInvalid: 'ACCOUNT_DELTA_ROW_COUNT_INVALID',
  rowLimitExceeded: 'ACCOUNT_DELTA_ROW_LIMIT_EXCEEDED',
} as const satisfies Record<string, string>;

export type AccountDeltaErrorCode =
  (typeof ACCOUNT_DELTA_ERROR_CODES)[keyof typeof ACCOUNT_DELTA_ERROR_CODES];

export class AccountDeltaError extends Error {
  readonly code: AccountDeltaErrorCode;

  constructor(code: AccountDeltaErrorCode, detail: string) {
    super(`${code}:${detail}`);
    this.name = 'AccountDeltaError';
    this.code = code;
  }
}

type InitialCreditLimits = Readonly<{
  left?: bigint;
  right?: bigint;
}>;

/**
 * The only constructor for a new token row in Account state.
 *
 * Every financial field is explicit in the resulting object. Callers may
 * provide committed credit policy, but absence always means zero credit—not a
 * product default inferred from UI, token metadata, or ambient Runtime state.
 */
export const createDefaultDelta = (
  tokenId: number,
  credit: InitialCreditLimits = {},
): Delta => ({
  tokenId,
  collateral: 0n,
  ondelta: 0n,
  offdelta: 0n,
  leftCreditLimit: credit.left ?? 0n,
  rightCreditLimit: credit.right ?? 0n,
  leftAllowance: 0n,
  rightAllowance: 0n,
  leftHold: 0n,
  rightHold: 0n,
});

/** Keep every live Account enforceable by Account.sol and bounded in memory. */
export const assertAccountDeltaCapacity = (
  rowCount: number,
  context: string,
): void => {
  if (!Number.isSafeInteger(rowCount) || rowCount < 0) {
    throw new AccountDeltaError(
      ACCOUNT_DELTA_ERROR_CODES.rowCountInvalid,
      `${context}:${rowCount}`,
    );
  }
  if (rowCount > LIMITS.MAX_ACCOUNT_TOKEN_ROWS) {
    throw new AccountDeltaError(
      ACCOUNT_DELTA_ERROR_CODES.rowLimitExceeded,
      `${context}:${rowCount}:${LIMITS.MAX_ACCOUNT_TOKEN_ROWS}`,
    );
  }
};
