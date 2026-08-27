export const BRAINVAULT_WORKER_CAP_STORAGE_KEY = 'xln-brainvault-worker-cap-v1';

export type BrainVaultWorkerCapInput = Readonly<{
  hardwareConcurrency: number;
  deviceMemoryGB: number;
  shardMemoryMB: number;
  isWebKit: boolean;
  storedCap?: number | null;
}>;

const asPositiveInteger = (value: unknown): number | null => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  const integer = Math.floor(numeric);
  return integer > 0 ? integer : null;
};

export const isBrainVaultWasmMemoryError = (message: string): boolean =>
  /out of memory|cannot allocate|wasm memory|WebAssembly\.instantiate/i.test(message);

export const nextBrainVaultWorkerCapAfterFailure = (current: number): number =>
  Math.max(1, Math.floor(Math.max(1, Math.floor(current)) / 2));

export const computeBrainVaultWorkerCap = (input: BrainVaultWorkerCapInput): number => {
  const cores = asPositiveInteger(input.hardwareConcurrency) ?? 4;
  const deviceMemoryGB = Math.max(input.isWebKit ? 2 : 4, Number(input.deviceMemoryGB) || 0);
  const shardMemoryMB = Math.max(1, Number(input.shardMemoryMB) || 1);

  // Browser Wasm allocations reserve more than the Argon2 shard buffer. Keep
  // this deliberately conservative; proven devices may persist a lower cap.
  const perWorkerBudgetMB = Math.max(512, shardMemoryMB * (input.isWebKit ? 3 : 2));
  const usableMemoryShare = input.isWebKit ? 0.25 : 0.35;
  const memoryBased = Math.max(
    1,
    Math.floor((deviceMemoryGB * 1024 * usableMemoryShare) / perWorkerBudgetMB),
  );
  const browserHardCap = input.isWebKit ? 2 : 8;
  const storedCap = asPositiveInteger(input.storedCap);
  return Math.max(1, Math.min(cores, memoryBased, browserHardCap, storedCap ?? browserHardCap));
};

export const resolveWalletBrainVaultShardWatchdog = (
  estimatedShardTimeMs: number,
  shardIndex: number,
): Readonly<{ timeoutMs: number; message: string }> => {
  const timeoutMs = Math.min(600_000, Math.max(300_000, Math.ceil(estimatedShardTimeMs * 10)));
  return {
    timeoutMs,
    message: `Shard ${shardIndex + 1} timed out after ${Math.ceil(timeoutMs / 1000)}s`,
  };
};

export const resolveWalletBrainVaultMemoryReduction = (state: Readonly<{
  activeWorkerCount: number;
  effectiveTargetWorkerCount: number;
  maxWorkers: number;
  targetWorkerCount: number;
}>): Readonly<{ maxWorkers: number; targetWorkerCount: number; notice: string }> => {
  const current = Math.max(state.activeWorkerCount, state.effectiveTargetWorkerCount, 1);
  const reduced = nextBrainVaultWorkerCapAfterFailure(current);
  const maxWorkers = Math.max(1, Math.min(state.maxWorkers, reduced));
  const targetWorkerCount = Math.max(1, Math.min(state.targetWorkerCount, maxWorkers));
  return {
    maxWorkers,
    targetWorkerCount,
    notice: `Browser memory pressure detected. BrainVault is continuing with ${maxWorkers} worker${maxWorkers === 1 ? '' : 's'}.`,
  };
};

export type WalletBrainVaultWorkerInitRetry =
  | Readonly<{ status: 'failed' }>
  | Readonly<{
      status: 'retry';
      attempts: number;
      initialWorkers: number;
      maxWorkers: number;
      targetWorkerCount: number;
      notice: string;
    }>;

export const resolveWalletBrainVaultWorkerInitRetry = (state: Readonly<{
  attempts: number;
  initialWorkers: number;
  maxWorkers: number;
  targetWorkerCount: number;
  message: string;
}>): WalletBrainVaultWorkerInitRetry => {
  if (state.attempts >= 4 || state.initialWorkers <= 1) return { status: 'failed' };
  if (!isBrainVaultWasmMemoryError(state.message)) return { status: 'failed' };
  const initialWorkers = nextBrainVaultWorkerCapAfterFailure(state.initialWorkers);
  if (initialWorkers === state.initialWorkers) return { status: 'failed' };
  return {
    status: 'retry',
    attempts: state.attempts + 1,
    initialWorkers,
    maxWorkers: Math.max(1, Math.min(state.maxWorkers, initialWorkers)),
    targetWorkerCount: Math.min(state.targetWorkerCount, initialWorkers),
    notice: `Browser memory pressure detected. BrainVault is retrying with ${initialWorkers} worker${initialWorkers === 1 ? '' : 's'}.`,
  };
};

export const walletBrainVaultWorkerInitFailureMessage = (message: string): string =>
  isBrainVaultWasmMemoryError(message)
    ? `BrainVault could not allocate browser Wasm memory. Reduce other tabs or retry with 1 worker. ${message}`
    : `BrainVault worker initialization failed: ${message}`;
