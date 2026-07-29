import type { AccountReplica } from '../../../../types/account';
import type { EntityState } from '../../../types';
import type { EntityTx } from '../../../../types/entity-tx';
import { addMessage } from '../../../frame-events';
import { initJBatch } from '../../../../jurisdiction/batch';
import { isCrossJurisdictionTerminalStatus } from '../../../../extensions/cross-j';
import { freezeAccountForDispute } from '../../../../account/consensus/dispute-policy';
import {
  collectDisputeEvidenceReadinessIssues,
  hasQueuedDisputeStart,
} from './shared';

type StartTx = Extract<EntityTx, { type: 'disputeStart' }>;

export const validateCrossJurisdictionDisputeRoute = (
  state: EntityState,
  tx: StartTx,
): void => {
  const routeId = tx.data.crossJurisdictionRouteId;
  if (!routeId) return;
  const route = state.crossJurisdictionSwaps?.get(routeId);
  if (!route || route.orderId !== routeId) {
    throw new Error(`DISPUTE_START_CROSS_J_ROUTE_MISSING:${routeId}`);
  }
  const localEntityId = state.entityId.toLowerCase();
  const counterpartyId = tx.data.counterpartyEntityId.toLowerCase();
  const isSourceAccount =
    route.source.entityId.toLowerCase() === localEntityId &&
    route.source.counterpartyEntityId.toLowerCase() === counterpartyId;
  const isTargetAccount =
    route.target.counterpartyEntityId.toLowerCase() === localEntityId &&
    route.target.entityId.toLowerCase() === counterpartyId;
  if (!isSourceAccount && !isTargetAccount) {
    throw new Error(`DISPUTE_START_CROSS_J_ROUTE_ROLE_MISMATCH:${routeId}`);
  }
  if (isCrossJurisdictionTerminalStatus(route.status) || !route.targetPull) {
    throw new Error(`DISPUTE_START_CROSS_J_ROUTE_INACTIVE:${routeId}:${route.status}`);
  }
};

export const admitDisputeStart = (
  state: EntityState,
  counterpartyId: string,
): AccountReplica | null => {
  state.jBatchState ??= initJBatch();
  if (state.jBatchState.sentBatch) {
    addMessage(
      state,
      `ℹ️ disputeStart queued to current batch while sentBatch nonce=${state.jBatchState.sentBatch.entityNonce} is still pending`,
    );
  }
  const account = state.accounts.get(counterpartyId);
  if (!account) {
    addMessage(state, `❌ No account with ${counterpartyId.slice(-4)} - cannot start dispute`);
    return null;
  }
  const status = account.status ?? 'active';
  if (status === 'disputed') {
    addMessage(state, `❌ Account with ${counterpartyId.slice(-4)} is disputed - reopen required`);
    return null;
  }
  if (status !== 'dispute_preparing') {
    addMessage(
      state,
      `❌ Account with ${counterpartyId.slice(-4)} must enter dispute preparation before disputeStart`,
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
      `⏳ disputeStart blocked until evidence is stable for ${counterpartyId.slice(-4)}: ${readinessIssues.join('; ')}`,
    );
    return null;
  }
  if (hasQueuedDisputeStart(state, counterpartyId)) {
    addMessage(
      state,
      `ℹ️ disputeStart already queued for ${counterpartyId.slice(-4)} (awaiting batch lifecycle)`,
    );
    return null;
  }
  return account;
};
