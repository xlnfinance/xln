import type {
  AccountState,
  EntityState,
  EntityTx,
  RuntimeState,
} from '../../../../types';
import { addMessage } from '../../../../state-helpers';
import { initJBatch } from '../../../../jurisdiction/batch';
import { freezeAccountForDispute } from '../../../../account/consensus/dispute-policy';
import {
  collectDisputeEvidenceReadinessIssues,
  hasQueuedDisputeFinalize,
  warnDisputeUnlessQuiet,
} from './shared';
import { shortId } from '../../../../infra/logger';

type FinalizeTx = Extract<EntityTx, { type: 'disputeFinalize' }>;

export const admitDisputeFinalize = (
  state: EntityState,
  tx: FinalizeTx,
  env: RuntimeState,
): AccountState | null => {
  const counterpartyId = tx.data.counterpartyEntityId;
  state.jBatchState ??= initJBatch();
  if (state.jBatchState.sentBatch) {
    addMessage(
      state,
      `ℹ️ disputeFinalize queued to current batch while sentBatch nonce=${state.jBatchState.sentBatch.entityNonce} is still pending`,
    );
  }
  const account = state.accounts.get(counterpartyId);
  if (!account) {
    addMessage(state, `❌ No account with ${counterpartyId.slice(-4)} - cannot finalize dispute`);
    return null;
  }
  if (!account.activeDispute) {
    addMessage(
      state,
      `❌ No active dispute with ${counterpartyId.slice(-4)} - must call disputeStart first`,
    );
    return null;
  }
  if (account.activeDispute.observedOnChain !== true) {
    addMessage(
      state,
      `⏳ disputeFinalize blocked until DisputeStarted is observed on-chain for ${counterpartyId.slice(-4)}`,
    );
    return null;
  }
  if (account.activeDispute.finalizeQueued) {
    addMessage(
      state,
      `ℹ️ disputeFinalize already queued for ${counterpartyId.slice(-4)} (awaiting batch lifecycle)`,
    );
    return null;
  }
  if (hasQueuedDisputeFinalize(state, counterpartyId)) {
    account.activeDispute.finalizeQueued = true;
    addMessage(
      state,
      `ℹ️ disputeFinalize already present in batch lifecycle for ${counterpartyId.slice(-4)}`,
    );
    return null;
  }
  if (tx.data.cooperative === true) {
    addMessage(
      state,
      `❌ disputeFinalize cooperative=true rejected for ${counterpartyId.slice(-4)} (unilateral-only protocol)`,
    );
    warnDisputeUnlessQuiet(env, 'finalize.cooperative_rejected', {
      counterparty: shortId(counterpartyId),
    });
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
