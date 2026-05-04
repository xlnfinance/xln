export const BRAINVAULT_WORKER_CAP_STORAGE_KEY = 'xln-brainvault-worker-cap-v1';

export type BrainVaultWorkerCapInput = {
  hardwareConcurrency: number;
  deviceMemoryGB: number;
  shardMemoryMB: number;
  isWebKit: boolean;
  storedCap?: number | null;
};

const asPositiveInteger = (value: unknown): number | null => {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const int = Math.floor(n);
  return int > 0 ? int : null;
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
  // this deliberately conservative; users can still increase within the cap if
  // their browser proves it can hold the memory.
  const perWorkerBudgetMB = Math.max(512, shardMemoryMB * (input.isWebKit ? 3 : 2));
  const usableMemoryShare = input.isWebKit ? 0.25 : 0.35;
  const memoryBased = Math.max(1, Math.floor((deviceMemoryGB * 1024 * usableMemoryShare) / perWorkerBudgetMB));
  const browserHardCap = input.isWebKit ? 2 : 8;
  const storedCap = asPositiveInteger(input.storedCap);

  return Math.max(1, Math.min(
    cores,
    memoryBased,
    browserHardCap,
    storedCap ?? browserHardCap,
  ));
};
