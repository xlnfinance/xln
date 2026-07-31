import { hasVerifiedEntityCommitPrecertificate } from '../../entity/consensus/commit-precheck';
import { mergeEntityInputs } from '../../entity/consensus/index';
import { cumulativeMarksToPhases } from '../../infra/perf-profile';
import { createStructuredLogger } from '../../infra/logger';
import {
  beginRuntimeCheckpointLineageRefresh,
  refreshRuntimeCheckpointLineageForEntity,
} from '../../storage/entity-lineage';
import type { RuntimeReplica, ReliableDeliveryReceipt, RoutedEntityInput, RuntimeInput, RuntimeTx } from '../types';
import type { JInput } from '../../jurisdiction/machine/input';
import { DEBUG } from '../../infra/debug-flags';
import { getPerfMs } from '../../infra/time';
import { attachEventEmitters } from '../env-events';
import { applyMergedEntityInputs } from '../entity-inputs';
import type { RuntimeEntityRoutingDeps } from '../entity-routing';
import { applyReliableDeliveryReceipts, type ReliableIngressCommit } from '../reliable-delivery';
import { applyRuntimeTx } from '../tx-handlers';
import {
  atomicCrossJPairIndexesThatDidNotCommit,
  admitAtomicCrossJAccountInputs,
} from './cross-j-atomic-admission';
import {
  markCommittedAtomicCrossJAckOutputs,
  recordRejectedAtomicCrossJInputs,
  summarizeAtomicCrossJAccountInput,
} from './cross-j-evidence';
import {
  prepareRuntimeInputIngress,
  validateRuntimeInputIngress,
  type RuntimeInputAdmissionDeps,
} from './input-admission';
import {
  advanceAppliedRuntimeFrame,
  buildAppliedRuntimeInput,
  commitRuntimeReliableIngress,
  type RuntimeReliableCommitDeps,
} from './input-finalize';
import { safeStringify } from '../../protocol/serialization';
import { nodeProcess } from '../../infra/runtime-process';

const runtimeLog = createStructuredLogger('runtime');
const APPLY_PROFILE_ENABLED =
  nodeProcess?.env?.['XLN_RUNTIME_APPLY_PROFILE'] === '1';
const APPLY_SLOW_MS = Math.max(
  0,
  Number(nodeProcess?.env?.['XLN_RUNTIME_APPLY_SLOW_MS'] || '500'),
);

export type RuntimeInputReducerDeps =
  RuntimeInputAdmissionDeps &
  RuntimeReliableCommitDeps & {
    assertApplyAllowed(env: RuntimeReplica): void;
    isReplay(env: RuntimeReplica): boolean;
    getRoutingDeps(): RuntimeEntityRoutingDeps;
  };

export type AppliedRuntimeInput = {
  entityOutbox: RoutedEntityInput[];
  mergedInputs: RoutedEntityInput[];
  jOutbox: JInput[];
  appliedRuntimeInput: RuntimeInput;
  reliableIngressCommits: ReliableIngressCommit[];
  immediateReliableReceipts: Array<{
    runtimeId: string;
    receipt: ReliableDeliveryReceipt;
  }>;
};

export type RuntimeInputReducer = {
  (env: RuntimeReplica, runtimeInput: RuntimeInput): Promise<AppliedRuntimeInput>;
  validate(env: RuntimeReplica, runtimeInput: RuntimeInput): void;
};

type ApplyProfiler = {
  mark(label: string): void;
  finish(env: RuntimeReplica, result: AppliedRuntimeInput, runtimeTxs: RuntimeTx[]): void;
};

const createApplyProfiler = (): ApplyProfiler => {
  const start = getPerfMs();
  const marks: Record<string, number> = {};
  return {
    mark: label => {
      marks[label] = Math.round(getPerfMs() - start);
    },
    finish: (env, result, runtimeTxs) => {
      const elapsedMs = Math.round(getPerfMs() - start);
      if (APPLY_PROFILE_ENABLED || elapsedMs >= APPLY_SLOW_MS) {
        runtimeLog.info('apply.profile', {
          height: env.state.height,
          elapsedMs,
          runtimeTxs: runtimeTxs.length,
          entityInputs: result.appliedRuntimeInput.entityInputs.length,
          entityTxs: result.appliedRuntimeInput.entityInputs.reduce(
            (sum, input) => sum + (input.entityTxs?.length ?? 0),
            0,
          ),
          outputs: result.entityOutbox.length,
          jOutputs: result.jOutbox.length,
          phases: cumulativeMarksToPhases(marks, elapsedMs),
        });
      }
      if (DEBUG) runtimeLog.debug('tick.completed', { height: env.state.height - 1, elapsedMs });
    },
  };
};

type LineageRefresh = {
  beforeEntityApply(entityId: string, force?: boolean): void;
  finalize(): void;
};

const createLineageRefresh = (env: RuntimeReplica): LineageRefresh => {
  const guards = new Map<
    string,
    ReturnType<typeof beginRuntimeCheckpointLineageRefresh>
  >();
  return {
    beforeEntityApply: (rawEntityId, force = false) => {
      const entityId = rawEntityId.trim().toLowerCase();
      if (force) {
        guards.get(entityId)?.finalize();
        guards.delete(entityId);
        refreshRuntimeCheckpointLineageForEntity(env, entityId);
      } else if (!guards.has(entityId)) {
        guards.set(entityId, beginRuntimeCheckpointLineageRefresh(env, entityId));
      }
    },
    finalize: () => {
      for (const guard of guards.values()) guard.finalize();
    },
  };
};

const applyRuntimeTransactions = async (
  env: RuntimeReplica,
  runtimeTxs: RuntimeTx[],
  isReplay: boolean,
  lineage: LineageRefresh,
): Promise<JInput[]> => {
  const jOutbox: JInput[] = [];
  for (const runtimeTx of runtimeTxs) {
    jOutbox.push(...await applyRuntimeTx(env, runtimeTx, { isReplay }));
    if (runtimeTx.type === 'importReplica') {
      // A repeated import can add a validator-local replica for the same
      // Entity, so rebuild that Entity's lineage after every import.
      lineage.beforeEntityApply(runtimeTx.entityId, true);
    }
  }
  return jOutbox;
};

const logAtomicCrossJCommit = (
  prepared: Awaited<ReturnType<typeof admitAtomicCrossJAccountInputs>>,
  batch: Awaited<ReturnType<typeof applyMergedEntityInputs>>,
): void => {
  if (prepared.pairs.length === 0) return;
  runtimeLog.info('crossj.atomic_pair_commit', {
    pairCount: prepared.pairs.length,
    outcomes: batch.inputOutcomes.map(({ outcome }, inputIndex) => ({
      inputIndex,
      entityId: prepared.inputs[inputIndex]?.entityId ?? 'missing',
      kind: outcome.kind,
    })),
    outputSummary: safeStringify(
      batch.entityOutbox.map((output, outputIndex) => ({
        outputIndex,
        ...summarizeAtomicCrossJAccountInput(output, outputIndex),
      })),
    ),
  });
};

type PreparedRuntimeIngress = ReturnType<typeof prepareRuntimeInputIngress>;
type AppliedEntityBatch = Awaited<ReturnType<typeof applyMergedEntityInputs>>;
type PreparedAtomicCrossJ = Awaited<ReturnType<typeof admitAtomicCrossJAccountInputs>>;

const applyRuntimeEntityBatch = async (
  env: RuntimeReplica,
  ingress: PreparedRuntimeIngress,
  mergedInputs: RoutedEntityInput[],
  isReplay: boolean,
  deps: RuntimeInputReducerDeps,
  profile: ApplyProfiler,
): Promise<{ prepared: PreparedAtomicCrossJ; batch: AppliedEntityBatch }> => {
  const lineage = createLineageRefresh(env);
  const runtimeJOutbox = await applyRuntimeTransactions(
    env,
    ingress.runtimeTxs,
    isReplay,
    lineage,
  );
  profile.mark('runtimeTxs');
  profile.mark('lineage');

  const initialJOutbox = [...ingress.jOutbox, ...runtimeJOutbox];
  const routingDeps = deps.getRoutingDeps();
  const prepared = admitAtomicCrossJAccountInputs(
    env,
    mergedInputs,
    isReplay,
  );
  profile.mark('atomicCrossJAdmission');
  const batch = await applyMergedEntityInputs(env, prepared.inputs, initialJOutbox, {
    isReplay,
    routingDeps,
    beforeEntityApply: lineage.beforeEntityApply,
  });
  const rejectedIndexes = new Set(
    batch.rejectedAtomicPairs.flatMap(rejection => rejection.inputIndexes),
  );
  for (const rejection of batch.rejectedAtomicPairs) {
    env.warn('network', rejection.code, {
      rejectedInputIndexes: rejection.inputIndexes,
      detail: rejection.detail,
    });
    recordRejectedAtomicCrossJInputs(
      env,
      prepared.inputs,
      rejection.inputIndexes,
      rejection.code,
      rejection.detail,
    );
  }
  const accepted = {
    ...prepared,
    pairs: prepared.pairs.filter(pair =>
      !rejectedIndexes.has(pair.sourceInputIndex) &&
      !rejectedIndexes.has(pair.targetInputIndex)),
  };
  lineage.finalize();
  logAtomicCrossJCommit(accepted, batch);
  profile.mark('entityApply');
  return { prepared: accepted, batch };
};

const finalizeRuntimeInputApply = (
  env: RuntimeReplica,
  runtimeInput: RuntimeInput,
  ingress: PreparedRuntimeIngress,
  prepared: PreparedAtomicCrossJ,
  batch: AppliedEntityBatch,
  isReplay: boolean,
  deps: RuntimeInputReducerDeps,
  profile: ApplyProfiler,
): AppliedRuntimeInput => {
  if (atomicCrossJPairIndexesThatDidNotCommit(prepared.pairs, batch.inputOutcomes).size) {
    throw new Error('RUNTIME_CROSS_J_ACCOUNT_PAIR_COMMIT_DIVERGED_FROM_ADMISSION');
  }
  markCommittedAtomicCrossJAckOutputs(batch.entityOutbox, prepared.pairs);
  const commits = commitRuntimeReliableIngress(
    env,
    ingress.entityInputs,
    batch.appliedEntityInputs,
    isReplay,
    deps,
  );
  profile.mark('reliableCommit');
  profile.mark('reliableLocalReceipts');
  profile.mark('reliableRelease');

  advanceAppliedRuntimeFrame(
    env,
    runtimeInput,
    ingress.runtimeTxs,
    batch.appliedEntityInputs,
    batch.entityFrameCommitted,
    batch.entityOutbox,
    batch.jOutbox,
    commits.length > 0,
  );
  profile.mark('finalize');
  const appliedRuntimeInput = buildAppliedRuntimeInput(
    env,
    runtimeInput,
    ingress.runtimeTxs,
    ingress.entityInputs,
    batch.appliedEntityInputs,
    commits,
  );
  profile.mark('durableReceiptInputs');
  return {
    entityOutbox: batch.entityOutbox,
    mergedInputs: batch.appliedEntityInputs,
    jOutbox: batch.jOutbox,
    appliedRuntimeInput,
    reliableIngressCommits: commits,
    immediateReliableReceipts: ingress.immediateReliableReceipts,
  };
};

const applyRuntimeInputPhases = async (
  env: RuntimeReplica,
  runtimeInput: RuntimeInput,
  deps: RuntimeInputReducerDeps,
  profile: ApplyProfiler,
  isReplay: boolean,
): Promise<{ result: AppliedRuntimeInput; profiledRuntimeTxs: RuntimeTx[] }> => {
  const ingress = prepareRuntimeInputIngress(env, runtimeInput, isReplay, deps);
  const mergedInputs = mergeEntityInputs(ingress.entityInputs, input =>
    hasVerifiedEntityCommitPrecertificate(env, input));
  profile.mark('validateMerge');
  if (runtimeInput.reliableReceipts?.length) {
    applyReliableDeliveryReceipts(env, runtimeInput.reliableReceipts);
  }
  const { prepared, batch } = await applyRuntimeEntityBatch(
    env,
    ingress,
    mergedInputs,
    isReplay,
    deps,
    profile,
  );
  const result = finalizeRuntimeInputApply(
    env,
    runtimeInput,
    ingress,
    prepared,
    batch,
    isReplay,
    deps,
    profile,
  );
  return { result, profiledRuntimeTxs: ingress.runtimeTxs };
};

export const createRuntimeInputReducer = (
  deps: RuntimeInputReducerDeps,
): RuntimeInputReducer => {
  const reducer: RuntimeInputReducer = async (env, runtimeInput) => {
    deps.assertApplyAllowed(env);
    if (!env.emit) attachEventEmitters(env);
    const profile = createApplyProfiler();
    const isReplay = deps.isReplay(env);

    try {
      if (isReplay) {
        runtimeLog.debug('input.replay.apply', {
          runtimeTxs: runtimeInput.runtimeTxs.length,
          entityInputs: runtimeInput.entityInputs.length,
        });
      }
      const { result, profiledRuntimeTxs } = await applyRuntimeInputPhases(
        env,
        runtimeInput,
        deps,
        profile,
        isReplay,
      );
      profile.finish(env, result, profiledRuntimeTxs);
      return result;
    } catch (error) {
      if (env.strictScenario) throw error;
      runtimeLog.error('apply_input.failed', {
        error: error instanceof Error ? error.message : String(error),
        ...(error instanceof Error && error.stack ? { stack: error.stack } : {}),
      });
      throw error;
    }
  };
  reducer.validate = (env, runtimeInput): void => {
    validateRuntimeInputIngress(env, runtimeInput, deps.isReplay(env), deps);
  };
  return reducer;
};
