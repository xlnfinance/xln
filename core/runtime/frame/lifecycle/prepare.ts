import { hasVerifiedEntityCommitPrecertificate } from '../../../entity/consensus/commit/precheck';
import {
  prioritizeEntityConsensusInputs,
} from '../../../entity/consensus';
import {
  causalTraceContainsWork,
  summarizeRuntimeAccountCausality,
} from '../../../qa/account-causal-trace';
import type { RuntimeReplica, RuntimeInput } from '../../types';
import { applyEntityHeightDurabilityBarrier } from '../../mempool/entity-height-barrier';
import { runtimeJInputFramePrefixLength } from '../../mempool/input-validation';
import { LIMITS } from '../../../config/constants';
import type { FrameExecutionState } from '../intake/execution-state';
import {
  ACCOUNT_CAUSAL_TRACE,
  countEntityInputTxKinds,
  type RuntimeProcessProfile,
} from '../process-profile';

export type RuntimeFramePreparationDeps = {
  prioritizeJEventFrame(input: RuntimeInput, mempool: RuntimeInput, timestamp: number): boolean;
  applyEntityTxFrameCap(input: RuntimeInput, mempool: RuntimeInput, limit: number, timestamp: number): boolean;
  applyEntityInputFrameCap(input: RuntimeInput, mempool: RuntimeInput, limit: number, timestamp: number): boolean;
};

const applyJInputFrameCap = (input: RuntimeInput, mempool: RuntimeInput, timestamp: number): void => {
  const jInputs = input.jInputs ?? [];
  const selected = runtimeJInputFramePrefixLength(jInputs);
  if (selected >= jInputs.length) return;
  input.jInputs = jInputs.slice(0, selected);
  mempool.jInputs = [...jInputs.slice(selected), ...(mempool.jInputs ?? [])];
  mempool.queuedAt ??= timestamp;
};

const countEntityTxs = (input: RuntimeInput): number =>
  input.entityInputs.reduce((sum, entityInput) => sum + (entityInput.entityTxs?.length ?? 0), 0);

export const prepareRuntimeFrameInput = async (
  env: RuntimeReplica,
  state: NonNullable<RuntimeReplica['infrastructure']>,
  input: RuntimeInput,
  mempool: RuntimeInput,
  queuedAt: number | undefined,
  frame: FrameExecutionState,
  profile: RuntimeProcessProfile,
  deps: RuntimeFramePreparationDeps,
): Promise<{ hasInput: boolean; jEventPrioritized: boolean }> => {
  profile.metrics.runtimeTxs = input.runtimeTxs.length;
  profile.metrics.entityInputs = input.entityInputs.length;
  profile.metrics.entityTxs = countEntityTxs(input);
  profile.metrics.jInputs = input.jInputs?.length ?? 0;
  mempool.runtimeTxs = [];
  mempool.entityInputs = [];
  if (mempool.jInputs) mempool.jInputs = [];
  mempool.queuedAt = undefined;
  frame.inputDrained = true;

  const timestamp = queuedAt ?? env.state.timestamp ?? 0;
  const jEventPrioritized = deps.prioritizeJEventFrame(input, mempool, timestamp);
  input.entityInputs = prioritizeEntityConsensusInputs(input.entityInputs, entityInput =>
    hasVerifiedEntityCommitPrecertificate(env, entityInput));
  applyEntityHeightDurabilityBarrier(env, input, mempool, timestamp);
  deps.applyEntityTxFrameCap(input, mempool, state.maxEntityTxsPerFrame ?? 0, timestamp);
  // Wakes and requeued deferred work join the detached mempool outside
  // admission, so even an uncapped Runtime bounds the frame by the per-input
  // limit; the remainder waits for the next frame.
  deps.applyEntityInputFrameCap(
    input,
    mempool,
    Math.min(state.maxEntityInputsPerFrame || LIMITS.MAX_RUNTIME_INPUT_ENTITY_INPUTS, LIMITS.MAX_RUNTIME_INPUT_ENTITY_INPUTS),
    timestamp,
  );
  applyJInputFrameCap(input, mempool, timestamp);
  frame.inputForRequeue = input;

  if (ACCOUNT_CAUSAL_TRACE) {
    const ingress = summarizeRuntimeAccountCausality(input.entityInputs);
    if (causalTraceContainsWork(ingress)) profile.metrics.accountCausality = { ingress, egress: [] };
  }
  profile.metrics.entityInputs = input.entityInputs.length;
  profile.metrics.entityTxs = countEntityTxs(input);
  const kinds = countEntityInputTxKinds(input.entityInputs);
  profile.metrics.txKinds = kinds.txKinds;
  profile.metrics.senders = kinds.senders;
  profile.mark('mempoolFrame');
  return {
    hasInput:
      input.runtimeTxs.length > 0 ||
      input.entityInputs.length > 0 ||
      (input.jInputs?.length ?? 0) > 0,
    jEventPrioritized,
  };
};
