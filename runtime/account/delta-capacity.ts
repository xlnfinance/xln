import { LIMITS } from '../config/constants';

/** Keep every live Account enforceable by Account.sol and bounded in memory. */
export const assertAccountDeltaCapacity = (
  rowCount: number,
  context: string,
): void => {
  if (!Number.isSafeInteger(rowCount) || rowCount < 0) {
    throw new Error(`ACCOUNT_DELTA_ROW_COUNT_INVALID:${context}:${rowCount}`);
  }
  if (rowCount > LIMITS.MAX_ACCOUNT_TOKEN_ROWS) {
    throw new Error(
      `ACCOUNT_DELTA_ROW_LIMIT_EXCEEDED:${context}:` +
      `${rowCount}:${LIMITS.MAX_ACCOUNT_TOKEN_ROWS}`,
    );
  }
};
