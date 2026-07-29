import { hasVerifiedEntityCommitPrecertificate } from '../../entity/consensus/commit-precheck';
import {
  prioritizeEntityConsensusInputs,
  prioritizeProtocolEntityInputs,
} from '../../entity/consensus';
import {
  causalTraceContainsWork,
  summarizeRuntimeAccountCausality,
} from '../../infra/account-causal-trace';
import { prepareHtlcPaymentEntityInputs } from '../../entity/htlc/payment-admission';
import type { RuntimeState, RuntimeInput } from '../types';
import { applyEntityHeightDurabilityBarrier } from '../entity-height-barrier';
import { cloneRuntimeFrameMempool } from './clone';
import type { FrameExecutionState } from './execution-state';
import {
  ACCOUNT_CAUSAL_TRACE,
  type RuntimeProcessProfile,
} from './process-profile';

export type RuntimeFramePreparationDeps = {
  prioritizeJEventFrame(input: RuntimeInput, mempool: RuntimeInput, timestamp: number): boolean;
  applyEntityTxFrameCap(input: RuntimeInput, mempool: RuntimeInput, limit: number, timestamp: number): boolean;
  applyEntityInputFrameCap(input: RuntimeInput, mempool: RuntimeInput, limit: number, timestamp: number): boolean;
};

const countEntityTxs = (input: RuntimeInput): number =>
  input.entityInputs.reduce((sum, entityInput) => sum + (entityInput.entityTxs?.length ?? 0), 0);

export const prepareRuntimeFrameInput = async (
  env: RuntimeState,
  state: NonNullable<RuntimeState['runtimeState']>,
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
  profile.metrics.reliableReceipts = input.reliableReceipts?.length ?? 0;
  mempool.runtimeTxs = [];
  mempool.entityInputs = [];
  if (mempool.jInputs) mempool.jInputs = [];
  if (mempool.reliableReceipts) mempool.reliableReceipts = [];
  mempool.queuedAt = undefined;
  frame.inputDrained = true;

  const timestamp = queuedAt ?? env.timestamp ?? 0;
  const jEventPrioritized = deps.prioritizeJEventFrame(input, mempool, timestamp);
  input.entityInputs = prioritizeEntityConsensusInputs(input.entityInputs, entityInput =>
    hasVerifiedEntityCommitPrecertificate(env, entityInput));
  input.entityInputs = prioritizeProtocolEntityInputs(input.entityInputs);
  applyEntityHeightDurabilityBarrier(env, input, mempool, timestamp);
  deps.applyEntityTxFrameCap(input, mempool, state.maxEntityTxsPerFrame ?? 0, timestamp);
  deps.applyEntityInputFrameCap(input, mempool, state.maxEntityInputsPerFrame ?? 0, timestamp);
  input.entityInputs = await prepareHtlcPaymentEntityInputs(env, input.entityInputs);
  frame.inputForRequeue = cloneRuntimeFrameMempool(input);

  if (ACCOUNT_CAUSAL_TRACE) {
    const ingress = summarizeRuntimeAccountCausality(input.entityInputs);
    if (causalTraceContainsWork(ingress)) profile.metrics.accountCausality = { ingress, egress: [] };
  }
  profile.metrics.entityInputs = input.entityInputs.length;
  profile.metrics.entityTxs = countEntityTxs(input);
  profile.mark('mempoolFrame');
  return {
    hasInput:
      input.runtimeTxs.length > 0 ||
      input.entityInputs.length > 0 ||
      (input.jInputs?.length ?? 0) > 0 ||
      (input.reliableReceipts?.length ?? 0) > 0,
    jEventPrioritized,
  };
};
