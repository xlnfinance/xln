import type { AccountReplica } from '../../../../types/account';
import type { EntityState } from '../../../types';
import type { EntityTx } from '../../../../types/entity-tx';
import { addMessage } from '../../../frame-events';
import { getEntityAccountForWrite } from '../../../state/persistent-account-map';
import { initJBatch } from '../../../../jurisdiction/machine/batch';
import { freezeAccountForDispute } from '../../../../account/consensus/dispute/policy';
import {
  collectDisputeEvidenceReadinessIssues,
  hasQueuedDisputeFinalize,
} from './shared';

type FinalizeTx = Extract<EntityTx, { type: 'disputeFinalize' }>;

export const admitDisputeFinalize = (
  state: EntityState,
  tx: FinalizeTx,
): AccountReplica | null => {
  const counterpartyId = tx.data.counterpartyEntityId;
  state.jBatchState ??= initJBatch();
  if (state.jBatchState.sentBatch) {
    addMessage(
      state,
      `ℹ️ disputeFinalize queued to current batch while sentBatch nonce=${state.jBatchState.sentBatch.entityNonce} is still pending`,
    );
  }
  const visible = state.accounts.get(counterpartyId);
  if (!visible) {
    addMessage(state, `❌ No account with ${counterpartyId.slice(-4)} - cannot finalize dispute`);
    return null;
  }
  if (!visible.activeDispute) {
    addMessage(
      state,
      `❌ No active dispute with ${counterpartyId.slice(-4)} - must call disputeStart first`,
    );
    return null;
  }
  if (visible.activeDispute.observedOnChain !== true) {
    addMessage(
      state,
      `⏳ disputeFinalize blocked until DisputeStarted is observed on-chain for ${counterpartyId.slice(-4)}`,
    );
    return null;
  }
  if (visible.activeDispute.finalizeQueued) {
    addMessage(
      state,
      `ℹ️ disputeFinalize already queued for ${counterpartyId.slice(-4)} (awaiting batch lifecycle)`,
    );
    return null;
  }
  const account = getEntityAccountForWrite(state.accounts, counterpartyId);
  if (!account?.activeDispute) return null;
  if (hasQueuedDisputeFinalize(state, counterpartyId)) {
    account.activeDispute.finalizeQueued = true;
    addMessage(
      state,
      `ℹ️ disputeFinalize already present in batch lifecycle for ${counterpartyId.slice(-4)}`,
    );
    return null;
  }
  freezeAccountForDispute(account, true);
  const readinessIssues = collectDisputeEvidenceReadinessIssues(
    account,
    Number(state.timestamp ?? 0),
  );
  if (readinessIssues.length > 0) {
    addMessage(
      state,
      `⏳ disputeFinalize blocked until evidence is stable for ${counterpartyId.slice(-4)}: ${readinessIssues.join('; ')}`,
    );
    return null;
  }
  return account;
};
