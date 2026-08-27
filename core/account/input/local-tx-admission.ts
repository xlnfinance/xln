import { appendAccountMempoolTxs } from './mempool';
import { txFingerprint } from '../../protocol/state/tx-multiset';
import type { AccountEnqueueInput, AccountReplica, AccountTx } from '../../types/account';
import type { HandleAccountInputResult } from '../consensus/types';
import { accountInputApplied } from '../consensus/result';
import { assertAccountTxsAdmissible } from '../tx/admission-policy';

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
  assertAccountTxsAdmissible([tx]);
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
export const applyAccountEnqueue = (
  account: AccountMempoolQueue,
  input: AccountEnqueueInput,
): HandleAccountInputResult => {
  // FX-1/FX-2 admission gate: an out-of-range policyVersion or an
  // out-of-profile kind is a loud typed error before any mempool write, so a
  // rejected batch admits nothing — the same whole-batch verdict as Rust
  // `AccountConsensus::admit_txs`.
  assertAccountTxsAdmissible(input.txs);
  const admitted = planLocalAccountTxAdmission(account, input.txs);
  appendAccountMempoolTxs(account, admitted, 'account:localInput');
  return accountInputApplied({
    events: [],
    admittedAccountTxCount: admitted.length,
  });
};
