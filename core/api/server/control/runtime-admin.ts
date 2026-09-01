/** Canonical admin-only Runtime diagnostics shared by every process host. */

import { verifyLiveRuntimeStorage } from '../../../runtime/composition';
import type { RuntimeReplica } from '../../../runtime/types';
import { withRuntimeCommittedRead } from '../../../runtime/frame/lifecycle/writer-lock';
import { RuntimeAdapterError } from '../../runtime-adapter/errors';
import { buildSettlementEvidence } from '../../runtime-adapter/control/settlement-evidence';
import type { RuntimeAdapterControlAction } from '../../runtime-adapter/types';

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

  // Settlement authority is the current committed Runtime snapshot. Account
  // history remains an on-demand inspection view and never joins consensus or
  // HLT completion, so this lease performs no storage round trip.
  return withRuntimeCommittedRead(env, () => buildSettlementEvidence(env, action));
};
