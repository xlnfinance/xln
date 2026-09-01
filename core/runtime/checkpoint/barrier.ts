import type { RuntimeTx } from '../types';

export type CheckpointBarrierRuntimeTx = Extract<RuntimeTx, { type: 'checkpointBarrier' }>;

const LOCAL_CHECKPOINT_BARRIER = Symbol('xln.local-checkpoint-barrier');

/** Create the only locally authorized Runtime transaction that forces a checkpoint frame. */
export const createCheckpointBarrierRuntimeTx = (): CheckpointBarrierRuntimeTx => {
  const tx: CheckpointBarrierRuntimeTx = { type: 'checkpointBarrier', data: {} };
  Object.defineProperty(tx, LOCAL_CHECKPOINT_BARRIER, { value: true });
  return tx;
};

export const isCheckpointBarrierRuntimeTx = (
  tx: RuntimeTx,
): tx is CheckpointBarrierRuntimeTx => tx.type === 'checkpointBarrier';

export const assertCheckpointBarrierRuntimeTxAuthorized = (
  tx: RuntimeTx,
  replay: boolean,
): void => {
  if (!isCheckpointBarrierRuntimeTx(tx)) return;
  if (
    replay ||
    (tx as CheckpointBarrierRuntimeTx & { [LOCAL_CHECKPOINT_BARRIER]?: boolean })[
      LOCAL_CHECKPOINT_BARRIER
    ] === true
  ) return;
  throw new Error('CHECKPOINT_BARRIER_EXTERNAL_RUNTIME_TX_REJECTED');
};
