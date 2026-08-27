export type WalletBrainVaultShardWorkSnapshot = Readonly<{
  retryQueue: readonly number[];
  nextShardToDispatch: number;
  shardCount: number;
}>;

export const hasPendingWalletBrainVaultShardWork = (
  snapshot: WalletBrainVaultShardWorkSnapshot,
): boolean => snapshot.retryQueue.length > 0
  || snapshot.nextShardToDispatch < snapshot.shardCount;

export type WalletBrainVaultShardRetry =
  | Readonly<{ status: 'completed'; attempts: number; retryQueue: readonly number[] }>
  | Readonly<{ status: 'queued'; attempts: number; retryQueue: readonly number[] }>
  | Readonly<{
      status: 'failed';
      attempts: number;
      retryQueue: readonly number[];
      message: string;
    }>;

export const resolveWalletBrainVaultShardRetry = (
  shardIndex: number,
  failureMessage: string,
  state: Readonly<{
    alreadyCompleted: boolean;
    currentAttempts: number;
    retryQueue: readonly number[];
  }>,
): WalletBrainVaultShardRetry => {
  if (state.alreadyCompleted) {
    return { status: 'completed', attempts: state.currentAttempts, retryQueue: state.retryQueue };
  }
  const attempts = state.currentAttempts + 1;
  if (attempts > 3) {
    return {
      status: 'failed',
      attempts,
      retryQueue: state.retryQueue,
      message: `BrainVault shard ${shardIndex + 1} failed repeatedly: ${failureMessage}`,
    };
  }
  const retryQueue = state.retryQueue.includes(shardIndex)
    ? state.retryQueue
    : [shardIndex, ...state.retryQueue];
  return { status: 'queued', attempts, retryQueue };
};

export type WalletBrainVaultShardDispatch =
  | Readonly<{
      status: 'idle';
      retryQueue: readonly number[];
      nextShardToDispatch: number;
    }>
  | Readonly<{
      status: 'dispatch';
      shardIndex: number;
      retryQueue: readonly number[];
      nextShardToDispatch: number;
    }>;

export type WalletBrainVaultCompletedShardLookup = Readonly<{
  has: (shardIndex: number) => boolean;
}>;

export const resolveWalletBrainVaultShardDispatch = (
  snapshot: WalletBrainVaultShardWorkSnapshot,
  completedShards: WalletBrainVaultCompletedShardLookup,
): WalletBrainVaultShardDispatch => {
  let nextShardToDispatch = snapshot.nextShardToDispatch;
  while (
    nextShardToDispatch < snapshot.shardCount
    && completedShards.has(nextShardToDispatch)
  ) nextShardToDispatch += 1;

  const retryQueue = [...snapshot.retryQueue];
  while (retryQueue.length > 0 && completedShards.has(retryQueue[0]!)) retryQueue.shift();
  if (retryQueue.length > 0) {
    const shardIndex = retryQueue.shift()!;
    return { status: 'dispatch', shardIndex, retryQueue, nextShardToDispatch };
  }
  if (nextShardToDispatch >= snapshot.shardCount) {
    return { status: 'idle', retryQueue, nextShardToDispatch };
  }
  return {
    status: 'dispatch',
    shardIndex: nextShardToDispatch,
    retryQueue,
    nextShardToDispatch: nextShardToDispatch + 1,
  };
};

export type WalletBrainVaultWorkerScale =
  | Readonly<{ status: 'unchanged' }>
  | Readonly<{ status: 'drain'; count: number }>
  | Readonly<{ status: 'add'; count: number }>;

export const resolveWalletBrainVaultWorkerScale = (
  activeWorkerCount: number,
  effectiveTargetWorkerCount: number,
  usableWorkerCap: number,
  hasPendingWork: boolean,
): WalletBrainVaultWorkerScale => {
  const target = Math.min(effectiveTargetWorkerCount, usableWorkerCap);
  if (target < activeWorkerCount) {
    return { status: 'drain', count: activeWorkerCount - target };
  }
  if (target > activeWorkerCount && hasPendingWork) {
    return { status: 'add', count: target - activeWorkerCount };
  }
  return { status: 'unchanged' };
};
