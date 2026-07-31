import { hasPendingSettlementTransition } from '../../account/tx/handlers/settle-transition';
import { isBatchEmpty } from '../../jurisdiction/machine/batch';
import type { EntityTx, PendingSettlementContinuation } from '../../types/entity-tx';
import type { EntityState } from '../types';
import { getAccountPerspective } from '../../account/perspective';
import { assertCanonicalSettlementWorkspace } from '../../account/tx/handlers/settle-transition';
import { compareStableText } from '../../protocol/serialization';

export type SettlementContinuationDisposition =
  | { kind: 'none' }
  | { kind: 'wait'; counterpartyId: string }
  | { kind: 'discard'; counterpartyId: string; reason: 'workspace_missing' | 'workspace_changed' | 'already_submitted' }
  | { kind: 'execute'; counterpartyId: string; txs: EntityTx[] };

const continuationActionToTx = (
  action: PendingSettlementContinuation['actions'][number],
): EntityTx => {
  if (action.type === 'r2r') {
    return {
      type: 'r2r',
      data: {
        toEntityId: action.toEntityId,
        tokenId: action.tokenId,
        amount: action.amount,
      },
    };
  }
  if (action.type === 'r2e') {
    return {
      type: 'r2e',
      data: {
        receivingEntity: action.receivingEntity,
        tokenId: action.tokenId,
        amount: action.amount,
      },
    };
  }
  return {
    type: 'r2c',
    data: {
      counterpartyId: action.counterpartyId,
      ...(action.receivingEntityId ? { receivingEntityId: action.receivingEntityId } : {}),
      tokenId: action.tokenId,
      amount: action.amount,
    },
  };
};

/**
 * Select at most one deterministic continuation per Entity frame.
 *
 * The continuation is signed Entity State, not a retry queue. Waiting is
 * therefore passive: a committed Account input or J event wakes the Entity.
 * We never poll and never consult wall-clock time.
 */
export const selectSettlementContinuation = (
  state: EntityState,
): SettlementContinuationDisposition => {
  const entries = [...(state.settlementContinuations?.entries() ?? [])]
    .sort(([left], [right]) => compareStableText(left, right));
  const entry = entries[0];
  if (!entry) return { kind: 'none' };
  const [counterpartyId, continuation] = entry;
  const account = state.accounts.get(counterpartyId);
  if (!account) {
    throw new Error(`SETTLEMENT_CONTINUATION_ACCOUNT_MISSING:${counterpartyId}`);
  }
  if (hasPendingSettlementTransition(account)) {
    return { kind: 'wait', counterpartyId };
  }
  const workspace = account.settlementWorkspace;
  if (!workspace) {
    return { kind: 'discard', counterpartyId, reason: 'workspace_missing' };
  }
  const workspaceHash = assertCanonicalSettlementWorkspace(account, workspace);
  if (workspaceHash !== continuation.workspaceHash) {
    return { kind: 'discard', counterpartyId, reason: 'workspace_changed' };
  }
  if (workspace.status === 'submitted') {
    return { kind: 'discard', counterpartyId, reason: 'already_submitted' };
  }
  if (workspace.status !== 'ready_to_submit') {
    return { kind: 'wait', counterpartyId };
  }
  if (workspace.executorIsLeft !== getAccountPerspective(account, state.entityId).iAmLeft) {
    throw new Error(`SETTLEMENT_CONTINUATION_EXECUTOR_MISMATCH:${counterpartyId}`);
  }
  if (
    state.jBatchState?.sentBatch ||
    (state.jBatchState && !isBatchEmpty(state.jBatchState.batch))
  ) {
    return { kind: 'wait', counterpartyId };
  }
  return {
    kind: 'execute',
    counterpartyId,
    txs: [
      {
        type: 'settle_execute',
        data: {
          counterpartyEntityId: counterpartyId,
          ...(continuation.actions.length > 0 ? { disableC2RShortcut: true } : {}),
        },
      },
      ...continuation.actions.map(continuationActionToTx),
      ...(continuation.broadcast ? [{ type: 'j_broadcast' as const, data: {} }] : []),
    ],
  };
};

export const hasActionableSettlementContinuation = (state: EntityState): boolean => {
  const disposition = selectSettlementContinuation(state);
  return disposition.kind === 'execute' || disposition.kind === 'discard';
};
