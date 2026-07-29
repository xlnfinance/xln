import { materializePendingJurisdictionImportResults } from '../jurisdiction-import';
import { submitRuntimeJOutbox, type RuntimeJOutboxQueue } from '../j-submit';
import { ensureRuntimeState } from '../runtime-state';
import type { RuntimeState, RuntimeInput, RuntimeTx } from '../types';
import type { JInput } from '../../jurisdiction/input';
import { getWallClockMs } from '../../infra/time';
import {
  dispatchCommittedEntityOutputs,
  dispatchCommittedReceipts,
  finalizeCommittedReceiptDeliveries,
  runCommittedRecoveryBarrier,
} from './dispatch';
import type { FrameExecutionState } from './execution-state';
import type { RuntimeFrameOutputPlan } from './plan';
import type { RuntimeProcessProfile } from './process-profile';
import type { RuntimeOutputRoutingDeps } from '../output-routing';

export type CommittedRuntimeEffectDeps = {
  enqueueRuntimeInputs: RuntimeJOutboxQueue;
  reconcileRuntimeInfraEffects(env: RuntimeState, runtimeTxs: readonly RuntimeTx[]): Promise<void>;
  notifyEnvChange(env: RuntimeState): void;
};

export type CommittedRuntimeEffects = {
  appliedInput: RuntimeInput | undefined;
  changedEntityIds: ReadonlySet<string>;
  jOutbox: JInput[];
  queuedJSubmitRetries: RuntimeTx[];
  outputPlan: RuntimeFrameOutputPlan;
  routing: RuntimeOutputRoutingDeps;
};

const countRuntimeInfraEffects = (input: RuntimeInput | undefined): number =>
  (input?.runtimeTxs ?? []).filter(
    tx => tx.type === 'importJ' || tx.type === 'completeImportJ' || tx.type === 'importReplica',
  ).length;

export const runCommittedRuntimeEffects = async (
  env: RuntimeState,
  frame: FrameExecutionState,
  effects: CommittedRuntimeEffects,
  profile: RuntimeProcessProfile,
  deps: CommittedRuntimeEffectDeps,
): Promise<void> => {
  const state = ensureRuntimeState(env);
  await runCommittedRecoveryBarrier(
    env,
    frame,
    effects.outputPlan.remoteOutputs.length,
    effects.jOutbox.length + effects.queuedJSubmitRetries.length,
    countRuntimeInfraEffects(effects.appliedInput),
  );
  profile.mark('recoveryBackup');

  await deps.reconcileRuntimeInfraEffects(env, effects.appliedInput?.runtimeTxs ?? []);
  await materializePendingJurisdictionImportResults(env, runtimeTx => {
    deps.enqueueRuntimeInputs(
      env,
      undefined,
      [runtimeTx],
      undefined,
      env.scenarioMode ? env.timestamp : getWallClockMs(),
    );
  });
  profile.mark('runtimeInfra');

  finalizeCommittedReceiptDeliveries(env, frame);
  if (effects.queuedJSubmitRetries.length > 0) {
    deps.enqueueRuntimeInputs(env, undefined, effects.queuedJSubmitRetries, undefined, env.timestamp);
  }

  await dispatchCommittedEntityOutputs(env, effects.changedEntityIds, effects.outputPlan, effects.routing);
  profile.mark('profileAnnounce');
  profile.metrics.pendingNetworkAfter = env.pendingNetworkOutputs?.length ?? 0;
  profile.metrics.deferredNetworkMeta = state.deferredNetworkMeta?.size ?? 0;
  profile.mark('dispatchOutputs');

  // Business outputs precede receipts on the same ordered post-WAL lane.
  dispatchCommittedReceipts(env, frame);
  profile.mark('dispatchReceipts');
  await submitRuntimeJOutbox(env, effects.jOutbox, {
    enqueueRuntimeInputs: deps.enqueueRuntimeInputs,
  });
  profile.mark('jOutbox');

  state.lastFrameAt = getWallClockMs();
  if (env.strictScenario) {
    const { assertRuntimeStateStrict } = await import('./assertions');
    await assertRuntimeStateStrict(env);
    profile.mark('strict');
  }
  deps.notifyEnvChange(env);
  profile.mark('notify');
};
