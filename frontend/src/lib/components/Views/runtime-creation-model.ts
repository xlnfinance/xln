export type FactorInfo = {
  factor: number;
  shards: number;
  tier: string;
};

export const FACTOR_INFO: FactorInfo[] = [
  { factor: 1, shards: 1, tier: 'Test' },
  { factor: 2, shards: 10, tier: 'Basic' },
  { factor: 3, shards: 100, tier: 'Standard' },
  { factor: 4, shards: 1000, tier: 'Strong' },
  { factor: 5, shards: 10000, tier: 'Maximum' },
];

export type WalletModeTradeoffs = {
  eyebrow: string;
  summary: string;
  benefits: readonly string[];
  costs: readonly string[];
  linkedCost?: Readonly<{
    text: string;
    href: string;
    linkText: string;
  }>;
};

export const WALLET_MODE_TRADEOFFS: Readonly<Record<'brainvault' | 'mnemonic', WalletModeTradeoffs>> = {
  brainvault: {
    eyebrow: 'Memory-backed recovery',
    summary: 'No separate recovery secret to record. Every passphrase guess pays the same Argon2 time and memory cost.',
    benefits: [
      'No secret paper, photo, or cloud backup to protect',
      'Each guess requires expensive time and memory work',
      'No separate recovery artifact to keep between uses',
    ],
    costs: [
      'The passphrase must be unique and non-obvious',
      'Exact name, passphrase, and work factor are required',
      'Recovery takes time and uses substantial device memory',
    ],
  },
  mnemonic: {
    eyebrow: 'Physical-backup recovery',
    summary: 'Strong randomness and instant recovery, exchanged for a secret that must remain hidden and available.',
    benefits: [
      'Correct implementations generate high-entropy seeds locally',
      'Fast recovery across standard compatible wallets',
    ],
    costs: [
      'The words must be recorded securely and never lost',
      'A photo, camera, visitor, or malware can copy them',
      'Anyone who obtains the words controls the wallet',
    ],
    linkedCost: {
      text: 'A faulty device or app RNG can make a generated seed guessable.',
      href: 'https://www.cryptotimes.io/2026/07/31/bitcoins-invisible-risk-coldcard-mk3-firmware-bug-leaves-btc-wallet-seeds-exposed-38m-drained/',
      linkText: 'Coldcard RNG incident',
    },
  },
};

export type BrainVaultWorkEstimate = {
  recoveryMs: number;
  totalMemoryWorkMb: number;
};

export function estimateBrainVaultWork(
  shardCount: number,
  shardMemoryMb: number,
  msPerShard: number,
  workers: number,
): BrainVaultWorkEstimate {
  if (!Number.isSafeInteger(shardCount) || shardCount < 1) {
    throw new Error(`BRAINVAULT_SHARD_COUNT_INVALID:${shardCount}`);
  }
  if (!Number.isFinite(shardMemoryMb) || shardMemoryMb <= 0) {
    throw new Error(`BRAINVAULT_SHARD_MEMORY_INVALID:${shardMemoryMb}`);
  }
  if (!Number.isFinite(msPerShard) || msPerShard <= 0) {
    throw new Error(`BRAINVAULT_SHARD_TIME_INVALID:${msPerShard}`);
  }
  if (!Number.isSafeInteger(workers) || workers < 1) {
    throw new Error(`BRAINVAULT_WORKER_COUNT_INVALID:${workers}`);
  }
  return {
    recoveryMs: Math.ceil(shardCount / workers) * msPerShard,
    totalMemoryWorkMb: shardCount * shardMemoryMb,
  };
}

const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

export function generateBase58Secret(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => BASE58[byte % BASE58.length]!).join('');
}

export function normalizeMnemonicPhrase(value: string): string {
  return String(value || '').trim().split(/\s+/).filter(Boolean).join(' ');
}

export function countMnemonicWords(value: string): number {
  const normalized = normalizeMnemonicPhrase(value);
  return normalized ? normalized.split(' ').length : 0;
}

export function hasSupportedMnemonicWordCount(value: string): boolean {
  const wordCount = countMnemonicWords(value);
  return wordCount === 12 || wordCount === 24;
}

export function formatUSD(value: number): string {
  if (value === 0) return '$0';
  if (value < 0.01) return '<$0.01';
  if (value >= 1000) return `$${(value / 1000).toFixed(1)}k`;
  return `$${value.toFixed(2)}`;
}

export function formatRuntimeDurationRounded(ms: number): string {
  const safeMs = Math.max(0, Math.floor(ms));
  const totalSeconds = Math.max(0, Math.ceil(safeMs / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes > 0 ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
}

export function formatMemoryLabel(memoryMb: number): string {
  if (memoryMb >= 1024 * 1024 * 1024) return `${(memoryMb / (1024 * 1024 * 1024)).toFixed(1)} PB`;
  if (memoryMb >= 1024 * 1024) return `${(memoryMb / (1024 * 1024)).toFixed(1)} TB`;
  if (memoryMb >= 1024) return `${(memoryMb / 1024).toFixed(1)} GB`;
  return `${Math.floor(memoryMb)} MB`;
}
