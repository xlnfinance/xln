import type { AccountMachine, AccountTx } from '../../types';

export function handleReopenDisputed(
  accountMachine: AccountMachine,
  accountTx: Extract<AccountTx, { type: 'reopen_disputed' }>,
): { success: boolean; events: string[]; error?: string } {
  const events: string[] = [];
  const requestedJNonce = Number(accountTx.data.jNonce);

  if (!Number.isFinite(requestedJNonce) || requestedJNonce < 0) {
    return { success: false, events, error: `Invalid reopen jNonce: ${String(accountTx.data.jNonce)}` };
  }

  if (accountMachine.activeDispute) {
    return { success: false, events, error: 'Cannot reopen while activeDispute exists' };
  }

  const knownJNonce = Number(accountMachine.jNonce ?? 0);
  if (requestedJNonce < knownJNonce) {
    return {
      success: false,
      events,
      error: `Reopen nonce stale: requested=${requestedJNonce}, known=${knownJNonce}`,
    };
  }

  accountMachine.jNonce = requestedJNonce;
  if (accountMachine.proofHeader.nextProofNonce <= requestedJNonce) {
    accountMachine.proofHeader.nextProofNonce = requestedJNonce + 1;
  }

  // Drop stale counterpart proofs from pre-dispute epoch.
  delete accountMachine.counterpartyDisputeProofHanko;
  delete accountMachine.counterpartyDisputeProofNonce;
  delete accountMachine.counterpartyDisputeProofBodyHash;
  delete accountMachine.disputePrepare;

  accountMachine.status = 'active';

  events.push(
    `🔓 Account reopened (jNonce=${requestedJNonce}, nextProofNonce=${accountMachine.proofHeader.nextProofNonce})`,
  );
  return { success: true, events };
}
