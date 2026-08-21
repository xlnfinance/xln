/** Canonical admin-only Runtime diagnostics shared by every process host. */

import {
  readPersistedAccountFrameHistory,
  verifyLiveRuntimeStorage,
} from '../../../runtime/composition';
import type { RuntimeReplica } from '../../../runtime/types';
import { withRuntimeCommittedRead } from '../../../runtime/frame/lifecycle/writer-lock';
import { RuntimeAdapterError } from '../../runtime-adapter/errors';
import { buildSettlementEvidence } from '../../runtime-adapter/control/settlement-evidence';
import type { RuntimeAdapterControlAction } from '../../runtime-adapter/types';

const settlementHistoryKey = (entityId: string, counterpartyEntityId: string): string =>
  `${entityId}:${counterpartyEntityId}`;

export const resolveRuntimeAdminControl = async (
  env: RuntimeReplica,
  action: RuntimeAdapterControlAction,
): Promise<unknown> => {
  if (action === 'verify-chain') {
    return withRuntimeCommittedRead(env, () => verifyLiveRuntimeStorage(env));
  }
  if (action.type !== 'settlement-evidence') {
    throw new RuntimeAdapterError('E_BAD_QUERY', 'unsupported runtime control');
  }

  // History is immutable certified WAL data. Reading up to 1,000 frames for
  // hundreds of accounts while holding the live committed-state lease used to
  // starve the single Runtime writer long enough for transport delivery to
  // time out. Load it first, then hold the lease only for the O(accounts) live
  // snapshot. A racing head is rejected by buildSettlementEvidence's exact
  // certified-head comparison, so this shortens the critical section without
  // weakening the evidence boundary.
  const histories = new Map<string, Awaited<ReturnType<typeof readPersistedAccountFrameHistory>>>();
  await Promise.all(action.accounts.map(async account => {
    const frames = await readPersistedAccountFrameHistory(
      env,
      account.entityId,
      account.counterpartyEntityId,
      1_000,
    );
    histories.set(settlementHistoryKey(account.entityId, account.counterpartyEntityId), frames);
  }));
  return withRuntimeCommittedRead(env, () => buildSettlementEvidence(
    env,
    action,
    async (_target, entityId, counterpartyEntityId) => {
      const frames = histories.get(settlementHistoryKey(entityId, counterpartyEntityId));
      if (!frames) {
        throw new Error(`RADAPTER_SETTLEMENT_HISTORY_MISSING:${entityId}:${counterpartyEntityId}`);
      }
      return frames;
    },
  ));
};
