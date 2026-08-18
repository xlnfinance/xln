import { hasVerifiedEntityCommitPrecertificate } from '../../../entity/consensus/commit/precheck';
import {
  prioritizeEntityConsensusInputs,
  prioritizeProtocolEntityInputs,
} from '../../../entity/consensus';
import {
  causalTraceContainsWork,
  summarizeRuntimeAccountCausality,
} from '../../../qa/account-causal-trace';
import type { RuntimeReplica, RuntimeInput } from '../../types';
import { applyEntityHeightDurabilityBarrier } from '../../mempool/entity-height-barrier';
import type { FrameExecutionState } from '../intake/execution-state';
import {
  ACCOUNT_CAUSAL_TRACE,
  countEntityInputTxKinds,
  type RuntimeProcessProfile,
} from '../process-profile';
import { runtimeInputHasExpiredAdapterCommand } from '../../command/frontier';
import { createStructuredLogger } from '../../../support/logger';

export type RuntimeFramePreparationDeps = {
  prioritizeJEventFrame(input: RuntimeInput, mempool: RuntimeInput, timestamp: number): boolean;
  applyEntityTxFrameCap(input: RuntimeInput, mempool: RuntimeInput, limit: number, timestamp: number): boolean;
  applyEntityInputFrameCap(input: RuntimeInput, mempool: RuntimeInput, limit: number, timestamp: number): boolean;
};

const prepareLog = createStructuredLogger('runtime.frame.prepare');

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
  if (runtimeInputHasExpiredAdapterCommand(input.runtimeTxs, env.state.timestamp ?? 0)) {
    prepareLog.info('adapter_command.expired_dropped', {
      runtimeTxs: input.runtimeTxs.length,
      entityInputs: input.entityInputs.length,
    });
    input.runtimeTxs = [];
    input.entityInputs = [];
    if (input.jInputs) input.jInputs = [];
  }
  const jEventPrioritized = deps.prioritizeJEventFrame(input, mempool, timestamp);
  input.entityInputs = prioritizeEntityConsensusInputs(input.entityInputs, entityInput =>
    hasVerifiedEntityCommitPrecertificate(env, entityInput));
  input.entityInputs = prioritizeProtocolEntityInputs(input.entityInputs);
  applyEntityHeightDurabilityBarrier(env, input, mempool, timestamp);
  deps.applyEntityTxFrameCap(input, mempool, state.maxEntityTxsPerFrame ?? 0, timestamp);
  deps.applyEntityInputFrameCap(input, mempool, state.maxEntityInputsPerFrame ?? 0, timestamp);
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
