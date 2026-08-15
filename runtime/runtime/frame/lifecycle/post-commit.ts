import { materializePendingJurisdictionImportResults } from '../../jurisdiction/jurisdiction-import';
import { submitRuntimeJOutbox, type RuntimeJOutboxQueue } from '../../jurisdiction/j-submit';
import { ensureRuntimeInfrastructure } from '../../infrastructure/runtime-infrastructure';
import type { ReliableDeliveryReceipt, RuntimeReplica, RuntimeInput, RuntimeTx } from '../../types';
import type { JInput } from '../../../jurisdiction/machine/input';
import { getWallClockMs } from '../../../infra/time';
import {
  dispatchCommittedEntityOutputs,
  dispatchCommittedReceipts,
  finalizeCommittedReceiptDeliveries,
  runCommittedRecoveryBarrier,
} from '../dispatch';
import type { FrameExecutionState } from '../input/execution-state';
import type { RuntimeFrameOutputPlan } from '../plan';
import type { RuntimeProcessProfile } from '../process-profile';
import type { RuntimeOutputRoutingDeps } from '../../routing/output-routing';

export type CommittedRuntimeEffectDeps = {
  enqueueRuntimeInputs(
    env: RuntimeReplica,
    inputs?: Parameters<RuntimeJOutboxQueue>[1],
    runtimeTxs?: RuntimeTx[],
    jInputs?: JInput[],
    explicitTimestamp?: number,
    reliableReceipts?: ReliableDeliveryReceipt[],
  ): void;
  reconcileRuntimeInfraEffects(env: RuntimeReplica, runtimeTxs: readonly RuntimeTx[]): Promise<void>;
  notifyEnvChange(env: RuntimeReplica): void;
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
  env: RuntimeReplica,
  frame: FrameExecutionState,
  effects: CommittedRuntimeEffects,
  profile: RuntimeProcessProfile,
  deps: CommittedRuntimeEffectDeps,
): Promise<void> => {
  const state = ensureRuntimeInfrastructure(env);
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
      env.scenarioMode ? env.state.timestamp : getWallClockMs(),
    );
  });
  profile.mark('runtimeInfra');

  finalizeCommittedReceiptDeliveries(env, frame);
  if (effects.queuedJSubmitRetries.length > 0) {
    deps.enqueueRuntimeInputs(env, undefined, effects.queuedJSubmitRetries, undefined, env.state.timestamp);
  }

  await dispatchCommittedEntityOutputs(env, effects.changedEntityIds, effects.outputPlan, effects.routing);
  profile.mark('profileAnnounce');
  profile.metrics.pendingNetworkAfter = env.pendingNetworkOutputs?.length ?? 0;
  profile.metrics.deferredNetworkMeta = state.deferredNetworkMeta?.size ?? 0;
  profile.mark('dispatchOutputs');

  // Business outputs precede receipts on the same ordered post-WAL lane.
  dispatchCommittedReceipts(env, frame, receipt => {
    deps.enqueueRuntimeInputs(env, undefined, undefined, undefined, env.state.timestamp, [receipt]);
  });
  profile.mark('dispatchReceipts');
  await submitRuntimeJOutbox(env, effects.jOutbox, {
    enqueueRuntimeInputs: deps.enqueueRuntimeInputs,
  });
  profile.mark('jOutbox');

  state.lastFrameAt = getWallClockMs();
  if (env.strictScenario) {
    const { assertRuntimeStateStrict } = await import('../assertions');
    await assertRuntimeStateStrict(env);
    profile.mark('strict');
  }
  deps.notifyEnvChange(env);
  profile.mark('notify');
};
