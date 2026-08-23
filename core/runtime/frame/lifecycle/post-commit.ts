import { materializePendingJurisdictionImportResults } from '../../j-submit/jurisdiction-import';
import { submitRuntimeJOutbox, type RuntimeJOutboxQueue } from '../../j-submit/j-submit';
import { ensureRuntimeInfrastructure } from '../../envelope/replica-envelope';
import type { RuntimeReplica, RuntimeInput, RuntimeTx } from '../../types';
import type { JInput } from '../../../jurisdiction/machine/input';
import { getWallClockMs } from '../../../support/time';
import { dispatchCommittedEntityOutputs, runCommittedRecoveryBarrier } from '../dispatch';
import type { RuntimeFrameOutputPlan } from '../plan';
import type { RuntimeProcessProfile } from '../process-profile';
import type { RuntimeOutputRoutingDeps } from '../../delivery/topology/output-routing';

export type CommittedRuntimeEffectDeps = {
  enqueueRuntimeInputs(
    env: RuntimeReplica,
    inputs?: Parameters<RuntimeJOutboxQueue>[1],
    runtimeTxs?: RuntimeTx[],
    jInputs?: JInput[],
    explicitTimestamp?: number,
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
  /** Start time of the committed live frame; absent for replay/scenario frames. */
  frameStartedAt?: number;
};

const countRuntimeInfraEffects = (input: RuntimeInput | undefined): number =>
  (input?.runtimeTxs ?? []).filter(
    tx => tx.type === 'importJ' || tx.type === 'completeImportJ' || tx.type === 'importReplica',
  ).length;

export const runCommittedRuntimeEffects = async (
  env: RuntimeReplica,
  effects: CommittedRuntimeEffects,
  profile: RuntimeProcessProfile,
  deps: CommittedRuntimeEffectDeps,
): Promise<void> => {
  const state = ensureRuntimeInfrastructure(env);
  await runCommittedRecoveryBarrier(
    env,
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

  if (effects.queuedJSubmitRetries.length > 0) {
    deps.enqueueRuntimeInputs(env, undefined, effects.queuedJSubmitRetries, undefined, env.state.timestamp);
  }

  await dispatchCommittedEntityOutputs(env, effects.changedEntityIds, effects.outputPlan, effects.routing);
  profile.mark('dispatchOutputs');
  profile.metrics.pendingNetworkAfter = env.pendingNetworkOutputs?.length ?? 0;

  await submitRuntimeJOutbox(env, effects.jOutbox, {
    enqueueRuntimeInputs: deps.enqueueRuntimeInputs,
  });
  profile.mark('jOutbox');

  if (effects.frameStartedAt !== undefined) state.lastFrameStartedAt = effects.frameStartedAt;
  if (env.strictScenario) {
    const { assertRuntimeStateStrict } = await import('../assertions');
    await assertRuntimeStateStrict(env);
    profile.mark('strict');
  }
  deps.notifyEnvChange(env);
  profile.mark('notify');
};
