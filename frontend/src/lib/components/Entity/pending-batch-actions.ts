import type { Env, EnvSnapshot, RoutedEntityInput } from '@xln/runtime/xln-api';
import { requireRuntimeEnv } from './entity-panel-model';
import { buildPendingBatchActionTxs, type PendingBatchAction } from './pending-batch-preview';

type PendingBatchActionRequest = {
  activeEnv: Env | EnvSnapshot | null | undefined;
  activeIsLive: boolean;
  entityId: string;
  action: PendingBatchAction;
  context: string;
  resolveEntitySigner: (entityId: string, context: string) => string;
  enqueueEntityInputs: (env: Env, inputs: RoutedEntityInput[]) => Promise<Env>;
};

type PendingBatchRunnerState = {
  pendingBatchCount: number;
  pendingBatchSubmitting: boolean;
  pendingBatchReserveIssueText: string | null;
  canBroadcastPendingBatch: boolean;
  hasSentBatch: boolean;
};

type PendingBatchActionRunnerOptions = {
  getState: () => PendingBatchRunnerState;
  setSubmitting: (submitting: boolean) => void;
  enqueueAction: (action: PendingBatchAction, context: string) => Promise<void>;
  confirmClear: () => boolean;
  notifySuccess: (message: string) => void;
  notifyError: (message: string) => void;
  formatError: (error: unknown, fallback: string) => string;
};

export function buildPendingBatchEntityInput(
  entityIdRaw: string,
  signerIdRaw: string,
  action: PendingBatchAction,
): RoutedEntityInput {
  const entityId = String(entityIdRaw || '').trim();
  const signerId = String(signerIdRaw || '').trim();
  if (!entityId) throw new Error('Active entity missing for pending batch action');
  if (!signerId) throw new Error(`Signer missing for pending batch action entity=${entityId}`);
  return {
    entityId,
    signerId,
    entityTxs: buildPendingBatchActionTxs(action),
  };
}

export async function enqueuePendingBatchAction(request: PendingBatchActionRequest): Promise<void> {
  const entityId = String(request.entityId || '').trim();
  if (!entityId) throw new Error('Active entity missing for pending batch action');
  const env = requireRuntimeEnv(request.activeEnv, request.context);
  if (!request.activeIsLive) throw new Error('Batch actions require LIVE mode');
  const signerId = request.resolveEntitySigner(entityId, request.context);
  await request.enqueueEntityInputs(env, [buildPendingBatchEntityInput(entityId, signerId, request.action)]);
}

export function createPendingBatchActionRunner(options: PendingBatchActionRunnerOptions) {
  return async (action: PendingBatchAction): Promise<void> => {
    const state = options.getState();
    if (state.pendingBatchSubmitting) return;
    if (action === 'clear') {
      if (!state.pendingBatchCount || !options.confirmClear()) return;
      await runPendingBatchAction(options, action, 'global-clear-batch', 'Batch cleared', 'Batch clear failed');
      return;
    }
    if (action === 'broadcast') {
      if (state.pendingBatchReserveIssueText) {
        options.notifyError(state.pendingBatchReserveIssueText);
        return;
      }
      if (!state.canBroadcastPendingBatch) return;
      await runPendingBatchAction(options, action, 'global-batch-broadcast', 'Broadcast queued', 'Batch broadcast failed');
      return;
    }
    if (!state.hasSentBatch) return;
    await runPendingBatchAction(
      options,
      action,
      'global-batch-rebroadcast',
      'Sent batch queued for rebroadcast',
      'Rebroadcast failed',
    );
  };
}

async function runPendingBatchAction(
  options: PendingBatchActionRunnerOptions,
  action: PendingBatchAction,
  context: string,
  successMessage: string,
  failurePrefix: string,
): Promise<void> {
  options.setSubmitting(true);
  try {
    await options.enqueueAction(action, context);
    options.notifySuccess(successMessage);
  } catch (error) {
    options.notifyError(`${failurePrefix}: ${options.formatError(error, 'Unknown error')}`);
  } finally {
    options.setSubmitting(false);
  }
}
