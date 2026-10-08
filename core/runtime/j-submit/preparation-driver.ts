import type { TronExpiryEvidence } from '../../jurisdiction/adapter/operations/tron-authority';
import { decodeSignedTronTransaction } from '../../jurisdiction/adapter/operations/tron-transaction';
import type { RuntimeReplica, RuntimeTx } from '../types';
import type { JAdapter, JPreparedTransactionAcceptance, JSubmitResult } from '../../jurisdiction/adapter/types';
import type { JTx } from '../../types/jurisdiction-runtime';
import { registerRuntimeFrameCommitCallback } from '../loop/loop-environment';
import { haltRuntimeRequiresOperator } from '../replica/lifecycle';
import { markLocalJSubmitRuntimeTx } from './j-submit-state';
import { validatePreparedJBatch } from './prepared-transaction';

type Batch = Extract<JTx, { type: 'batch' }>;

/** The caller waits only for queued preparation, never for the next frame it must drive. */
export const beginJPreparation = async (
  env: RuntimeReplica, adapter: JAdapter, jurisdictionName: string, batch: Batch,
  options: Parameters<JAdapter['submitTx']>[1],
  enqueue: (tx: RuntimeTx) => void,
  result: (result: JSubmitResult) => Promise<void>,
  replacement?: TronExpiryEvidence,
): Promise<void> => {
  const attempt = batch.data.runtimeSubmitAttempt;
  if (!attempt) throw new Error('J_PREPARATION_ATTEMPT_MISSING');
  env.infrastructure ??= {};
  const tasks = env.infrastructure.jPreparationTasks ??= new Map();
  if (tasks.has(attempt.attemptId)) return;
  // Another preparation may hold this EOA queue until the next frame commits.
  // Waiting for that second task here would prevent precisely that frame.
  const waitForPreparation = tasks.size === 0;
  let queued = false;
  let cancelled = false;
  let ready!: () => void;
  let fail!: (error: unknown) => void;
  const started = new Promise<void>((resolve, reject) => { ready = resolve; fail = reject; });
  const task = adapter.submitTx(batch, { ...options, prepareOnly: async prepared => {
    validatePreparedJBatch(env, jurisdictionName, batch, prepared.rawTransaction);
    const committed = new Promise<JPreparedTransactionAcceptance>((resolve, reject) => {
      const unsubscribe = registerRuntimeFrameCommitCallback(env, ({ runtimeInput }) => {
        if (!runtimeInput.runtimeTxs.some(tx => (tx.type === 'recordJPreparedTransaction' || tx.type === 'replaceJPreparedTransaction')
          && tx.data.attemptId === attempt.attemptId)) return;
        clearTimeout(timeout);
        unsubscribe();
        const pending = env.infrastructure?.pendingCommittedJOutbox?.flatMap(input => input.jTxs)
          .find(tx => tx.type === 'batch' && tx.data.runtimeSubmitAttempt?.attemptId === attempt.attemptId);
        cancelled = !pending;
        resolve(cancelled ? 'rejected' : 'accepted');
      });
      const timeout = setTimeout(() => { unsubscribe(); reject(new Error('J_PREPARATION_WAL_TIMEOUT')); }, 900_000);
      const data = { jurisdictionName, attemptId: attempt.attemptId, rawTransaction: prepared.rawTransaction };
      if (replacement) {
        if (!attempt.rawTransaction) throw new Error('J_REPLACEMENT_PREVIOUS_WIRE_MISSING');
        enqueue(markLocalJSubmitRuntimeTx({ type: 'replaceJPreparedTransaction', data: { ...data,
          previousTransactionHash: decodeSignedTronTransaction(attempt.rawTransaction).hash, evidence: replacement } }));
      } else enqueue(markLocalJSubmitRuntimeTx({ type: 'recordJPreparedTransaction', data }));
    });
    queued = true;
    ready();
    return committed;
  } }).then(async submission => {
    if (!queued) await result(submission);
    else if (!submission.success && !cancelled) throw new Error(`J_PREPARATION_ACCEPTANCE_FAILED:${submission.error}`);
    ready();
  }).catch(error => {
    if (waitForPreparation) fail(error);
    haltRuntimeRequiresOperator(env, error);
  }).finally(() => { tasks.delete(attempt.attemptId); });
  tasks.set(attempt.attemptId, task);
  if (waitForPreparation) await started;
};
