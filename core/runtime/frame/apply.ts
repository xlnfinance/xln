import { createStructuredLogger } from '../../support/logger';
import {
  causalTraceContainsWork,
  summarizeRuntimeAccountCausality,
} from '../../qa/account-causal-trace';
import type { RuntimeReplica, RoutedEntityInput, RuntimeInput, RuntimeTx } from '../types';
import type { JInput } from '../../jurisdiction/machine/input';
import { getPerfMs } from '../../support/time';
import {
  registerPendingCommittedJOutbox,
  splitJOutboxForDurableSubmit,
} from '../j-submit/j-submit-state';
import { refreshScheduledWakeIndex } from '../mempool/scheduled-wake';
import type { FrameExecutionState } from './intake/execution-state';
import {
  ACCOUNT_CAUSAL_TRACE,
  type RuntimeProcessProfile,
} from './process-profile';
import { assertCrossJLocalCohorts } from '../delivery/topology/cross-j-topology';
import type { EntityInfraContext } from '../../types/entity/infra-context';

const runtimeLog = createStructuredLogger('runtime');

export type RuntimeInputApplyResult = {
  entityContexts: Map<string, EntityInfraContext>;
  entityOutbox: RoutedEntityInput[];
  jOutbox: JInput[];
  appliedRuntimeInput: RuntimeInput;
};

export type RuntimeFrameApplyDeps = {
  applyRuntimeInput(env: RuntimeReplica, input: RuntimeInput): Promise<RuntimeInputApplyResult>;
  setApplyAllowed(env: RuntimeReplica, allowed: boolean): void;
};

export type RuntimeFrameApplyOutput = {
  appliedInput: RuntimeInput | undefined;
  entityOutbox: RoutedEntityInput[];
  jOutbox: JInput[];
  queuedJSubmitRetries: RuntimeTx[];
  changedEntityIds: Set<string>;
};

const collectChangedEntityIds = (
  input: RuntimeInput,
  appliedInput: RuntimeInput,
): Set<string> => new Set([
  ...input.runtimeTxs.flatMap(tx => tx.type === 'importReplica' ? [tx.entityId.toLowerCase()] : []),
  ...appliedInput.entityInputs.flatMap(entityInput =>
    entityInput.entityId ? [entityInput.entityId.toLowerCase()] : []),
]);


const recordApplyEgress = (
  profile: RuntimeProcessProfile,
  entityOutbox: RoutedEntityInput[],
): void => {
  if (!ACCOUNT_CAUSAL_TRACE) return;
  const egress = summarizeRuntimeAccountCausality(entityOutbox);
  if (!causalTraceContainsWork(egress)) return;
  profile.metrics.accountCausality = {
    ingress: profile.metrics.accountCausality?.ingress ?? [],
    egress,
  };
};

export const applyPreparedRuntimeFrame = async (
  env: RuntimeReplica,
  input: RuntimeInput,
  hasInput: boolean,
  jEventPrioritized: boolean,
  quietLogs: boolean,
  frame: FrameExecutionState,
  profile: RuntimeProcessProfile,
  deps: RuntimeFrameApplyDeps,
): Promise<RuntimeFrameApplyOutput> => {
  let appliedInput: RuntimeInput | undefined;
  let entityOutbox: RoutedEntityInput[] = [];
  let jOutbox: JInput[] = [];
  let queuedJSubmitRetries: RuntimeTx[] = [];
  let changedEntityIds = new Set<string>();
  if (hasInput) {
    if (!quietLogs) {
      runtimeLog.debug('tick.input.processing', {
        entityInputs: input.entityInputs.length,
        entityIds: input.entityInputs.map(entityInput => entityInput.entityId.slice(-4)),
      });
      if (jEventPrioritized) runtimeLog.debug('tick.input.deferred_for_j_event');
      if (input.runtimeTxs.length > 0) {
        runtimeLog.debug('tick.runtime_txs.processing', { runtimeTxs: input.runtimeTxs.length });
      }
    }
    try {
      deps.setApplyAllowed(env, true);
      const reducerStartedAt = profile.enabled ? getPerfMs() : 0;
      const result = await deps.applyRuntimeInput(env, input);
      // A Runtime frame may create/import both siblings together, never leave
      // a live half-cohort that would only be discovered after restart.
      assertCrossJLocalCohorts(env);
      if (profile.enabled) profile.metrics.reducerMs = getPerfMs() - reducerStartedAt;
      profile.mark('apply');
      if (!quietLogs && (result.entityOutbox.length > 0 || result.jOutbox.length > 0)) {
        runtimeLog.debug('process.apply.output', {
          entityOutbox: result.entityOutbox.length,
          jOutbox: result.jOutbox.length,
        });
      }
      entityOutbox = result.entityOutbox;
      recordApplyEgress(profile, entityOutbox);
      const split = splitJOutboxForDurableSubmit(result.jOutbox);
      registerPendingCommittedJOutbox(env, split.durable);
      queuedJSubmitRetries = split.retries;
      jOutbox = split.maintenance;
      appliedInput = result.appliedRuntimeInput;
      frame.entityContexts = result.entityContexts;
      changedEntityIds = collectChangedEntityIds(input, result.appliedRuntimeInput);
      // Output planning runs due hooks before publish performs its full rebuild.
      // Refresh changed replicas now so hooks scheduled by this frame can enter
      // the next Runtime input without waiting for an unrelated later tick.
      refreshScheduledWakeIndex(env, changedEntityIds);
      profile.mark('fingerprints');
    } finally {
      deps.setApplyAllowed(env, false);
    }
  }
  jOutbox = [...(env.infrastructure?.pendingCommittedJOutbox ?? []), ...jOutbox];
  return { appliedInput, entityOutbox, jOutbox, queuedJSubmitRetries, changedEntityIds };
};
