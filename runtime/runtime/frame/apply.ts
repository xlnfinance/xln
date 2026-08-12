import { createStructuredLogger } from '../../infra/logger';
import {
  causalTraceContainsWork,
  summarizeRuntimeAccountCausality,
} from '../../qa/account-causal-trace';
import { cloneIsolatedRuntimeInput } from '../input-pipeline/input-clone';
import type { RuntimeReplica, ReliableDeliveryReceipt, RoutedEntityInput, RuntimeInput, RuntimeTx } from '../types';
import type { JInput } from '../../jurisdiction/machine/input';
import { getPerfMs } from '../../infra/time';
import {
  captureReliableReceiptSenderCheckpoint,
  type ReliableIngressCommit,
} from '../reliable/reliable-delivery.ts';
import {
  registerPendingCommittedJOutbox,
  splitJOutboxForDurableSubmit,
} from '../jurisdiction/j-submit-state';
import { refreshScheduledWakeIndex } from '../input-pipeline/scheduled-wake';
import type { FrameExecutionState } from './input/execution-state';
import {
  ACCOUNT_CAUSAL_TRACE,
  type RuntimeProcessProfile,
} from './process-profile';
import { assertCrossJLocalCohorts } from '../routing/cross-j-topology';

const runtimeLog = createStructuredLogger('runtime');

export type RuntimeInputApplyResult = {
  entityOutbox: RoutedEntityInput[];
  jOutbox: JInput[];
  appliedRuntimeInput: RuntimeInput;
  reliableIngressCommits: ReliableIngressCommit[];
  immediateReliableReceipts: Array<{
    runtimeId: string;
    receipt: ReliableDeliveryReceipt;
  }>;
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

const queueProfileCertification = (
  env: RuntimeReplica,
  changedEntityIds: ReadonlySet<string>,
): void => {
  const state = env.infrastructure!;
  const candidates = state.pendingProfileCertificationEntityIds ?? new Set<string>();
  for (const entityId of changedEntityIds) {
    const certified = [...env.state.eReplicas.values()].some(
      replica =>
        replica.entityId.toLowerCase() === entityId &&
        Boolean(replica.state.profileEncryptionManifest),
    );
    if (!certified) candidates.add(entityId);
  }
  state.pendingProfileCertificationEntityIds = candidates;
};

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
  hasPendingReliableOutput: boolean,
  frame: FrameExecutionState,
  profile: RuntimeProcessProfile,
  deps: RuntimeFrameApplyDeps,
): Promise<RuntimeFrameApplyOutput> => {
  if ((input.reliableReceipts?.length ?? 0) > 0 || hasPendingReliableOutput) {
    frame.reliableReceiptSenderCheckpoint = captureReliableReceiptSenderCheckpoint(env);
  }

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
      appliedInput = cloneIsolatedRuntimeInput(result.appliedRuntimeInput);
      frame.reliableIngressCommits = result.reliableIngressCommits;
      frame.immediateReliableReceiptDeliveries = result.immediateReliableReceipts;
      refreshScheduledWakeIndex(
        env,
        new Set(input.entityInputs.map(entityInput => entityInput.entityId.toLowerCase())),
      );
      changedEntityIds = collectChangedEntityIds(input, result.appliedRuntimeInput);
      queueProfileCertification(env, changedEntityIds);
      profile.mark('fingerprints');
    } finally {
      deps.setApplyAllowed(env, false);
    }
  }
  jOutbox = [...(env.infrastructure?.pendingCommittedJOutbox ?? []), ...jOutbox];
  return { appliedInput, entityOutbox, jOutbox, queuedJSubmitRetries, changedEntityIds };
};
