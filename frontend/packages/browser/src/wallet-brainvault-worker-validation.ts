type UnknownRecord = Readonly<Record<string, unknown>>;

const isRecord = (value: unknown): value is UnknownRecord =>
  typeof value === 'object' && value !== null;

export const BRAINVAULT_SHARD_TIME_MIN_MS = 100;
export const BRAINVAULT_SHARD_TIME_MAX_MS = 86_400_000;

export const normalizeWalletBrainVaultShardTimeSample = (value: unknown): number | null => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null;
  return Math.min(BRAINVAULT_SHARD_TIME_MAX_MS, Math.max(BRAINVAULT_SHARD_TIME_MIN_MS, value));
};

export type WalletBrainVaultWorkerMessage =
  | Readonly<{ kind: 'ready' }>
  | Readonly<{
      kind: 'probe-result';
      measuredShardTimeMs: number | null;
      reportedShardTimeMs: unknown;
    }>
  | Readonly<{
      kind: 'shard-complete';
      shardIndex: unknown;
      resultHex: unknown;
      elapsedMs: unknown;
    }>
  | Readonly<{ kind: 'failed'; error: unknown }>
  | Readonly<{ kind: 'invalid'; message: string }>;

export type WalletBrainVaultShardCompleteMessage = Extract<
  WalletBrainVaultWorkerMessage,
  { kind: 'shard-complete' }
>;

const decodeReadyMessage = (
  data: UnknownRecord | null,
  expectedSpecId: string,
): WalletBrainVaultWorkerMessage => {
  const actualSpecId = data?.['specId'];
  return actualSpecId === expectedSpecId
    ? { kind: 'ready' }
    : {
        kind: 'invalid',
        message: `BRAINVAULT_WORKER_SPEC_MISMATCH:${String(actualSpecId)}:${expectedSpecId}`,
      };
};

const decodeProbeMessage = (data: UnknownRecord | null): WalletBrainVaultWorkerMessage => {
  const reportedShardTimeMs = data?.['estimatedShardTimeMs'];
  return {
    kind: 'probe-result',
    measuredShardTimeMs: normalizeWalletBrainVaultShardTimeSample(reportedShardTimeMs),
    reportedShardTimeMs,
  };
};

const decodeShardMessage = (data: UnknownRecord | null): WalletBrainVaultWorkerMessage => ({
  kind: 'shard-complete',
  shardIndex: data?.['shardIndex'],
  resultHex: data?.['resultHex'],
  elapsedMs: data?.['elapsedMs'],
});

export const decodeWalletBrainVaultWorkerMessage = (
  value: unknown,
  expectedSpecId: string,
): WalletBrainVaultWorkerMessage => {
  if (!isRecord(value) || typeof value['type'] !== 'string') {
    return { kind: 'invalid', message: 'BRAINVAULT_WORKER_MESSAGE_INVALID' };
  }
  const messageType = value['type'];
  const rawData = value['data'];
  const data = isRecord(rawData) ? rawData : null;
  if (messageType === 'ready') return decodeReadyMessage(data, expectedSpecId);
  if (messageType === 'probe_result') return decodeProbeMessage(data);
  if (messageType === 'shard_complete') return decodeShardMessage(data);
  if (messageType === 'error') {
    return { kind: 'failed', error: data?.['message'] ?? 'Worker failed' };
  }
  return { kind: 'invalid', message: `BRAINVAULT_WORKER_MESSAGE_UNKNOWN:${messageType}` };
};

export const normalizeWalletBrainVaultWorkerError = (error: unknown): string => {
  if (error instanceof Error) return error.message;
  if (isRecord(error) && 'message' in error) {
    return String(error['message'] ?? 'Worker failed');
  }
  return String(error || 'Worker failed');
};

export type WalletBrainVaultShardCompletion = Readonly<{
  shardIndex: number;
  resultHex: string;
  measuredShardTimeMs: number | null;
}>;

const validateShardIndex = (
  value: unknown,
  context: Readonly<{ activeShard: number | undefined; shardCount: number }>,
): number => {
  if (!Number.isSafeInteger(value)) {
    throw new Error(`BRAINVAULT_WORKER_SHARD_INDEX_INVALID:${String(value)}`);
  }
  const shardIndex = Number(value);
  if (shardIndex < 0 || shardIndex >= context.shardCount) {
    throw new Error(`BRAINVAULT_WORKER_SHARD_INDEX_INVALID:${String(value)}`);
  }
  if (context.activeShard !== shardIndex) {
    throw new Error(`BRAINVAULT_WORKER_SHARD_MISMATCH:${String(context.activeShard)}:${shardIndex}`);
  }
  return shardIndex;
};

const validateResultHex = (value: unknown, expectedLength: number): string => {
  if (typeof value === 'string' && value.length === expectedLength) return value;
  const actualLength = typeof value === 'string' ? value.length : typeof value;
  throw new Error(`BRAINVAULT_WORKER_RESULT_INVALID:${actualLength}`);
};

export const validateWalletBrainVaultShardCompletion = (
  message: WalletBrainVaultShardCompleteMessage,
  context: Readonly<{
    activeShard: number | undefined;
    shardCount: number;
    expectedResultHexLength: number;
    alreadyCompleted: boolean;
  }>,
): WalletBrainVaultShardCompletion => {
  const shardIndex = validateShardIndex(message.shardIndex, context);
  const resultHex = validateResultHex(message.resultHex, context.expectedResultHexLength);
  if (context.alreadyCompleted) {
    throw new Error(`BRAINVAULT_WORKER_DUPLICATE_SHARD:${shardIndex}`);
  }
  return {
    shardIndex,
    resultHex,
    measuredShardTimeMs: normalizeWalletBrainVaultShardTimeSample(message.elapsedMs),
  };
};
