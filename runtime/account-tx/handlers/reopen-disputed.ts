import type { AccountMachine, AccountTx } from '../../types';

export function handleReopenDisputed(
  accountMachine: AccountMachine,
  accountTx: Extract<AccountTx, { type: 'reopen_disputed' }>,
): { success: boolean; events: string[]; error?: string } {
  const events: string[] = [];
  const requestedOnChainNonce = Number(accountTx.data.onChainNonce);

  if (!Number.isFinite(requestedOnChainNonce) || requestedOnChainNonce < 0) {
    return { success: false, events, error: `Invalid reopen onChainNonce: ${String(accountTx.data.onChainNonce)}` };
  }

  if (accountMachine.activeDispute) {
    return { success: false, events, error: 'Cannot reopen while activeDispute exists' };
  }

  const knownOnChainNonce = Number(accountMachine.onChainSettlementNonce ?? 0);
  if (requestedOnChainNonce < knownOnChainNonce) {
    return {
      success: false,
      events,
      error: `Reopen nonce stale: requested=${requestedOnChainNonce}, known=${knownOnChainNonce}`,
    };
  }

  accountMachine.onChainSettlementNonce = requestedOnChainNonce;
  if (accountMachine.proofHeader.nonce <= requestedOnChainNonce) {
    accountMachine.proofHeader.nonce = requestedOnChainNonce + 1;
  }

  // Drop stale counterpart proofs from pre-dispute epoch.
  delete accountMachine.counterpartyDisputeProofHanko;
  delete accountMachine.counterpartyDisputeProofNonce;
  delete accountMachine.counterpartyDisputeProofBodyHash;

  accountMachine.status = 'active';

  events.push(
    `🔓 Account reopened (onChainNonce=${requestedOnChainNonce}, nextProofNonce=${accountMachine.proofHeader.nonce})`,
  );
  return { success: true, events };
}
