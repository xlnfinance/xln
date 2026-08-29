export type WalletNodeBrainVaultAdapterSnapshot = Readonly<{
  mode: string;
  status: string;
  authLevel: string | null;
}>;

export type WalletNodeBrainVaultAccess<Adapter> =
  | Readonly<{ status: 'ready'; adapter: Adapter }>
  | Readonly<{ status: 'blocked'; message: string }>;

export type WalletNodeBrainVaultProgress = Readonly<{
  completed: number;
  total: number;
  lastShardMs: number;
  workers: number;
}>;

export type WalletNodeBrainVaultProgressValidation =
  | Readonly<{ valid: true }>
  | Readonly<{ valid: false; message: string }>;

export const resolveWalletNodeBrainVaultAccess = <Adapter extends WalletNodeBrainVaultAdapterSnapshot>(
  adapter: Adapter | null,
): WalletNodeBrainVaultAccess<Adapter> => {
  if (!adapter || adapter.mode !== 'remote' || adapter.status !== 'connected') {
    return {
      status: 'blocked',
      message: 'The selected node is not connected. Reconnect it before BrainVault recovery.',
    };
  }
  if (adapter.authLevel !== 'admin') {
    return {
      status: 'blocked',
      message: 'Admin access to the selected node is required for BrainVault recovery.',
    };
  }
  return { status: 'ready', adapter };
};

export const validateWalletNodeBrainVaultProgress = (
  progress: WalletNodeBrainVaultProgress,
  expectedShardCount: number,
): WalletNodeBrainVaultProgressValidation => (
  progress.total !== expectedShardCount
  || progress.completed < 0
  || progress.completed > progress.total
    ? {
        valid: false,
        message: 'The node returned invalid BrainVault progress and was cancelled.',
      }
    : { valid: true }
);

export const assertWalletNodeBrainVaultResult = (
  result: Readonly<{ specId: string; shardCount: number }>,
  expectedSpecId: string,
  expectedShardCount: number,
): void => {
  if (result.specId !== expectedSpecId || result.shardCount !== expectedShardCount) {
    throw new Error('BRAINVAULT_NODE_RESULT_SPEC_MISMATCH');
  }
};

export const nextWalletNodeShardTimeMs = (
  currentMs: number,
  lastShardMs: number,
): number => currentMs > 0
  ? currentMs * 0.7 + lastShardMs * 0.3
  : lastShardMs;
