import {
  FinancialDataCorruptionError,
  validateMapInstance,
  validateNumber,
  validateObject,
} from '../protocol/validation-primitives';

const validateBalances = (value: unknown, context: string): void => {
  const balancesByOwner = validateMapInstance(value, context);
  for (const [owner, rawBalances] of balancesByOwner) {
    if (typeof owner !== 'string') {
      throw new FinancialDataCorruptionError(`${context} owner must be string`, {
        owner,
      });
    }
    const balances = validateMapInstance(rawBalances, `${context}[${owner}]`);
    for (const [tokenKey, rawRecord] of balances) {
      if (typeof tokenKey !== 'string') {
        throw new FinancialDataCorruptionError(
          `${context} token key must be string`,
          { tokenKey },
        );
      }
      const item = `${context}[${owner}][${tokenKey}]`;
      const record = validateObject(rawRecord, item);
      if (typeof record['tokenAddress'] !== 'string') {
        throw new FinancialDataCorruptionError(`${item}.tokenAddress must be string`);
      }
      if (typeof record['balance'] !== 'bigint') {
        throw new FinancialDataCorruptionError(`${item}.balance must be bigint`);
      }
      validateNumber(record['jHeight'], `${item}.jHeight`);
    }
  }
};

const validateAllowances = (value: unknown, context: string): void => {
  const allowancesByOwner = validateMapInstance(value, context);
  for (const [owner, rawAllowances] of allowancesByOwner) {
    if (typeof owner !== 'string') {
      throw new FinancialDataCorruptionError(`${context} owner must be string`, {
        owner,
      });
    }
    const allowances = validateMapInstance(rawAllowances, `${context}[${owner}]`);
    for (const [allowanceKey, rawRecord] of allowances) {
      if (typeof allowanceKey !== 'string') {
        throw new FinancialDataCorruptionError(
          `${context} key must be string`,
          { allowanceKey },
        );
      }
      const item = `${context}[${owner}][${allowanceKey}]`;
      const record = validateObject(rawRecord, item);
      if (
        typeof record['tokenAddress'] !== 'string' ||
        typeof record['spender'] !== 'string'
      ) {
        throw new FinancialDataCorruptionError(`${item} addresses must be strings`);
      }
      if (typeof record['allowance'] !== 'bigint') {
        throw new FinancialDataCorruptionError(`${item}.allowance must be bigint`);
      }
      validateNumber(record['jHeight'], `${item}.jHeight`);
    }
  }
};

export const validateExternalWalletState = (
  value: unknown,
  context: string,
): void => {
  if (value === undefined) return;
  const wallet = validateObject(value, `${context}.externalWallet`);
  validateBalances(wallet['balances'], `${context}.externalWallet.balances`);
  validateAllowances(wallet['allowances'], `${context}.externalWallet.allowances`);
};
