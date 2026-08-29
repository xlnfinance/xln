export type WalletBrainVaultFinalizationStart =
  | Readonly<{ status: 'pending' }>
  | Readonly<{ status: 'in-progress' }>
  | Readonly<{ status: 'start' }>;

export const resolveWalletBrainVaultFinalizationStart = (state: Readonly<{
  completedShardCount: number;
  shardCount: number;
  finalizeInProgress: boolean;
}>): WalletBrainVaultFinalizationStart => {
  if (state.finalizeInProgress) return { status: 'in-progress' };
  if (state.completedShardCount < state.shardCount) return { status: 'pending' };
  return { status: 'start' };
};

export const resolveWalletBrainVaultFinalizationShardOrder = (
  shardCount: number,
  completedShardIndexes: ReadonlySet<number>,
): readonly number[] => {
  if (!Number.isSafeInteger(shardCount) || shardCount < 1) {
    throw new Error('BRAINVAULT_FINALIZATION_SHARD_COUNT_INVALID');
  }
  const order: number[] = [];
  for (let shardIndex = 0; shardIndex < shardCount; shardIndex += 1) {
    if (!completedShardIndexes.has(shardIndex)) throw new Error(`Missing shard ${shardIndex}`);
    order.push(shardIndex);
  }
  return order;
};

export type WalletBrainVaultFinalizationCommit =
  | Readonly<{ status: 'cancelled' }>
  | Readonly<{ status: 'commit'; recoveryLabel: string }>;

export const resolveWalletBrainVaultFinalizationCommit = (state: Readonly<{
  isCurrentRun: boolean;
  name: string;
  ethereumAddress: string;
}>): WalletBrainVaultFinalizationCommit => {
  if (!state.isCurrentRun) return { status: 'cancelled' };
  const name = state.name.trim();
  return {
    status: 'commit',
    recoveryLabel: name || `Wallet ${state.ethereumAddress.slice(0, 6)}`,
  };
};
