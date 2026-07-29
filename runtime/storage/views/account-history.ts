import { createStructuredLogger } from '../../infra/logger';
import { setAccountFrameHistoryView } from '../../runtime/env-events';
import type { RuntimeState } from '../../runtime/types';
import { readHistoryViewAccountFrames } from '..';
import type { RuntimeStorageApiDeps } from '../runtime-storage-deps';

const runtimeLog = createStructuredLogger('runtime');

/**
 * Account frame history is a disposable read model, never live Account state.
 * A hydration failure is therefore observable but cannot invalidate an already
 * verified Runtime restore. The authoritative frames remain in the Runtime WAL
 * and the view can be rebuilt from them.
 */
export const createAccountFrameHistoryHydrator = (
  deps: RuntimeStorageApiDeps,
) => async (env: RuntimeState, limit = 0): Promise<void> => {
  if (limit <= 0) return;
  try {
    if (!(await deps.tryOpenRuntimeWalDb(env))) return;
    const db = deps.getRuntimeWalDb(env);
    for (const [replicaKey, replica] of env.eReplicas.entries()) {
      const entityId = String(
        replica?.entityId || String(replicaKey).split(':')[0] || '',
      ).toLowerCase();
      if (!entityId || !replica?.state?.accounts) continue;
      for (const [counterpartyId, account] of replica.state.accounts.entries()) {
        const accountHeight = Math.max(
          0,
          Math.floor(Number(account.currentHeight ?? 0)),
        );
        const records = await readHistoryViewAccountFrames(
          db,
          entityId,
          String(counterpartyId).toLowerCase(),
          {
            limit,
            maxRuntimeHeight: env.height,
            maxAccountHeight: accountHeight,
          },
        );
        setAccountFrameHistoryView(
          account,
          records.map(record => record.frame),
          limit,
        );
      }
    }
  } catch (error) {
    runtimeLog.warn('account_frame_history.hydrate_failed', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
};
