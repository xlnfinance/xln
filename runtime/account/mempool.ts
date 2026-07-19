import { LIMITS } from '../constants';
import type { AccountMachine, AccountTx } from '../types';

type AccountMempoolSubject = Pick<AccountMachine, 'mempool'> & {
  pendingFrame?: AccountMachine['pendingFrame'] | undefined;
};

const pendingAccountTxCount = (account: AccountMempoolSubject): number =>
  account.pendingFrame?.accountTxs.length ?? 0;

export const assertAccountMempoolWithinLimit = (
  account: AccountMempoolSubject,
  context: string,
): void => {
  if (!Array.isArray(account.mempool)) {
    throw new Error(`ACCOUNT_MEMPOOL_INVALID: context=${context}`);
  }
  const pending = pendingAccountTxCount(account);
  const outstanding = account.mempool.length + pending;
  if (outstanding <= LIMITS.ACCOUNT_MEMPOOL_SIZE) return;
  throw new Error(
    `ACCOUNT_MEMPOOL_LIMIT_EXCEEDED: context=${context} ` +
      `mempool=${account.mempool.length} pending=${pending} ` +
      `outstanding=${outstanding} limit=${LIMITS.ACCOUNT_MEMPOOL_SIZE}`,
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
  const pending = pendingAccountTxCount(account);
  const next = account.mempool.length + pending + incoming;
  if (next <= LIMITS.ACCOUNT_MEMPOOL_SIZE) return;
  throw new Error(
    `ACCOUNT_MEMPOOL_LIMIT_EXCEEDED: context=${context} ` +
      `mempool=${account.mempool.length} pending=${pending} incoming=${incoming} ` +
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
