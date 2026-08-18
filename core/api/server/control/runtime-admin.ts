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

export const resolveRuntimeAdminControl = (
  env: RuntimeReplica,
  action: RuntimeAdapterControlAction,
): Promise<unknown> => withRuntimeCommittedRead<unknown>(env, () => {
  if (action === 'verify-chain') return verifyLiveRuntimeStorage(env);
  if (action.type === 'settlement-evidence') {
    return buildSettlementEvidence(env, action, readPersistedAccountFrameHistory);
  }
  throw new RuntimeAdapterError('E_BAD_QUERY', 'unsupported runtime control');
});
