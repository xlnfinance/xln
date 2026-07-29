import { appendAccountMempoolTxs } from './mempool';
import { txFingerprint } from '../protocol/tx-multiset';
import type { AccountLocalInput, AccountReplica, AccountTx } from '../types';
import type { HandleAccountInputResult } from './consensus/types';

type AccountMempoolQueue = Pick<AccountReplica, 'mempool' | 'pendingFrame'>;

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
  const admitted = planLocalAccountTxAdmission(account, [tx]);
  appendAccountMempoolTxs(account, admitted, 'account:localAdmission');
  return admitted.length === 1;
};

const planLocalAccountTxAdmission = (
  account: AccountMempoolQueue,
  txs: readonly AccountTx[],
): AccountTx[] => {
  const seenLifecycle = new Set([
    ...account.mempool,
    ...(account.pendingFrame?.accountTxs ?? []),
  ].filter(tx => tx.type !== 'direct_payment').map(txFingerprint));
  const admitted: AccountTx[] = [];
  for (const tx of txs) {
    if (tx.type === 'direct_payment') {
      admitted.push(tx);
      continue;
    }
    const fingerprint = txFingerprint(tx);
    if (seenLifecycle.has(fingerprint)) continue;
    seenLifecycle.add(fingerprint);
    admitted.push(tx);
  }
  return admitted;
};

/** Apply the local-only branch of the canonical AccountInput boundary. */
export const applyLocalAccountInput = (
  account: AccountMempoolQueue,
  input: AccountLocalInput,
): HandleAccountInputResult => {
  const admitted = planLocalAccountTxAdmission(account, input.txs);
  appendAccountMempoolTxs(account, admitted, 'account:localInput');
  return {
    success: true,
    events: [],
    admittedAccountTxCount: admitted.length,
  };
};
