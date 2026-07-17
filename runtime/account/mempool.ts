import { LIMITS } from '../constants';
import type { AccountMachine, AccountTx } from '../types';

type AccountMempoolSubject = Pick<AccountMachine, 'mempool'>;

export const assertAccountMempoolWithinLimit = (
  account: AccountMempoolSubject,
  context: string,
): void => {
  if (!Array.isArray(account.mempool)) {
    throw new Error(`ACCOUNT_MEMPOOL_INVALID: context=${context}`);
  }
  if (account.mempool.length <= LIMITS.ACCOUNT_MEMPOOL_SIZE) return;
  throw new Error(
    `ACCOUNT_MEMPOOL_LIMIT_EXCEEDED: context=${context} ` +
      `mempool=${account.mempool.length} limit=${LIMITS.ACCOUNT_MEMPOOL_SIZE}`,
  );
};

const assertAccountMempoolAdmission = (
  account: AccountMempoolSubject,
  incoming: number,
  context: string,
): void => {
  assertAccountMempoolWithinLimit(account, context);
  if (!Number.isSafeInteger(incoming) || incoming < 0) {
    throw new Error(`ACCOUNT_MEMPOOL_INCOMING_INVALID: context=${context} incoming=${incoming}`);
  }
  const next = account.mempool.length + incoming;
  if (next <= LIMITS.ACCOUNT_MEMPOOL_SIZE) return;
  throw new Error(
    `ACCOUNT_MEMPOOL_LIMIT_EXCEEDED: context=${context} ` +
      `existing=${account.mempool.length} incoming=${incoming} ` +
      `limit=${LIMITS.ACCOUNT_MEMPOOL_SIZE}`,
  );
};

export const appendAccountMempoolTxs = (
  account: AccountMempoolSubject,
  txs: readonly AccountTx[],
  context: string,
): void => {
  assertAccountMempoolAdmission(account, txs.length, context);
  if (txs.length > 0) account.mempool.push(...txs);
};

export const prependAccountMempoolTxs = (
  account: AccountMempoolSubject,
  txs: readonly AccountTx[],
  context: string,
): void => {
  assertAccountMempoolAdmission(account, txs.length, context);
  if (txs.length > 0) account.mempool.unshift(...txs);
};

export const appendAccountMempoolTx = (
  account: AccountMempoolSubject,
  tx: AccountTx,
  context: string,
): void => appendAccountMempoolTxs(account, [tx], context);
