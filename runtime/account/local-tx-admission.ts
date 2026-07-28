import { appendAccountMempoolTx } from './mempool';
import { txFingerprint } from '../state-helpers';
import type { AccountLocalInput, AccountState, AccountTx } from '../types';
import type { HandleAccountInputResult } from './consensus/types';

type AccountMempoolQueue = Pick<AccountState, 'mempool' | 'pendingFrame'>;

/**
 * Admit one locally authorized Account transaction into the future-frame
 * mempool. This policy belongs to the Account machine even though an EntityTx
 * commonly produces the command.
 *
 * Separately authorized payments retain multiplicity: identical payment bytes
 * still represent distinct money movement. Protocol lifecycle commands are
 * idempotent by exact payload across both queued and pending-frame work.
 */
export const admitLocalAccountTx = (
  account: AccountMempoolQueue,
  tx: AccountTx,
): boolean => {
  if (tx.type === 'direct_payment') {
    appendAccountMempoolTx(account, tx, 'accountMachine:localPayment');
    return true;
  }

  const fingerprint = txFingerprint(tx);
  for (const existing of account.mempool) {
    if (txFingerprint(existing) === fingerprint) return false;
  }
  for (const pendingTx of account.pendingFrame?.accountTxs ?? []) {
    if (txFingerprint(pendingTx) === fingerprint) return false;
  }
  appendAccountMempoolTx(account, tx, 'accountMachine:localLifecycle');
  return true;
};

/** Apply the local-only branch of the canonical AccountInput boundary. */
export const applyLocalAccountInput = (
  account: AccountMempoolQueue,
  input: AccountLocalInput,
): HandleAccountInputResult => {
  let admittedAccountTxCount = 0;
  for (const tx of input.txs) {
    if (admitLocalAccountTx(account, tx)) admittedAccountTxCount += 1;
  }
  return { success: true, events: [], admittedAccountTxCount };
};
