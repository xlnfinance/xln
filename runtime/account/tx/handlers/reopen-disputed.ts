import type { AccountReplica, AccountTx } from '../../../types';

export function handleReopenDisputed(
  account: AccountReplica,
  accountTx: Extract<AccountTx, { type: 'reopen_disputed' }>,
): { success: boolean; events: string[]; error?: string } {
  const events: string[] = [];
  const requestedJNonce = Number(accountTx.data.jNonce);

  if (!Number.isFinite(requestedJNonce) || requestedJNonce < 0) {
    return { success: false, events, error: `Invalid reopen jNonce: ${String(accountTx.data.jNonce)}` };
  }

  if (account.activeDispute) {
    return { success: false, events, error: 'Cannot reopen while activeDispute exists' };
  }

  const knownJNonce = Number(account.jNonce ?? 0);
  if (requestedJNonce < knownJNonce) {
    return {
      success: false,
      events,
      error: `Reopen nonce stale: requested=${requestedJNonce}, known=${knownJNonce}`,
    };
  }

  account.jNonce = requestedJNonce;
  if (account.proofHeader.nextProofNonce <= requestedJNonce) {
    account.proofHeader.nextProofNonce = requestedJNonce + 1;
  }

  // Drop stale counterpart proofs from pre-dispute epoch.
  delete account.counterpartyDisputeProofHanko;
  delete account.counterpartyDisputeProofNonce;
  delete account.counterpartyDisputeProofBodyHash;
  delete account.disputePrepare;

  account.status = 'active';

  events.push(
    `🔓 Account reopened (jNonce=${requestedJNonce}, nextProofNonce=${account.proofHeader.nextProofNonce})`,
  );
  return { success: true, events };
}
