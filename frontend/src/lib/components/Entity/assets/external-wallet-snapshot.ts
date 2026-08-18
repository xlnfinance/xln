import type { RuntimeReplica, JAdapter } from '@xln/core/api/public/runtime-module';
import type { ExternalWalletSnapshotSource } from './../asset-ledger';

export type { ExternalWalletSnapshotSource } from './../asset-ledger';

export type ExternalAllowanceRead = { tokenAddress: string; spender: string };

export type ExternalWalletReadResult = {
  nativeBalance: bigint;
  balances: bigint[];
  allowanceValues: bigint[];
  sourceHeight?: number;
  sourceHash?: string;
  finalityDepth?: number;
  headBlockNumber?: number;
  tokenErrors?: Array<{ tokenAddress: string; error: string }>;
  allowanceErrors?: Array<{ tokenAddress: string; spender: string; error: string }>;
};

export type ExternalWalletSnapshotResponse = {
  success?: boolean;
  entityId?: string;
  owner?: string;
  blockNumber?: number;
  blockHash?: string;
  sourceHeight?: number;
  sourceHash?: string;
  finalityDepth?: number;
  headBlockNumber?: number;
  transactionHash?: string;
  nativeBalance?: string;
  tokenBalances?: Array<{ tokenAddress?: string; tokenId?: number; balance?: string; error?: string }>;
  allowances?: Array<{ tokenAddress?: string; spender?: string; allowance?: string; error?: string }>;
  tokenErrors?: Array<{ tokenAddress?: string; error?: string }>;
  allowanceErrors?: Array<{ tokenAddress?: string; spender?: string; error?: string }>;
  error?: string;
};

export type ResolvedExternalWalletSnapshotSource = ExternalWalletSnapshotSource & {
  sourceHash: string;
  finalityDepth: number;
  headBlockNumber: number;
};

export type ExternalWalletSnapshotIngressDecision =
  | 'apply'
  | 'cancel-runtime-changed'
  | 'cancel-runtime-quiescing';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const hasOnlyKeys = (value: Record<string, unknown>, allowed: readonly string[]): boolean =>
  Object.keys(value).every((key) => allowed.includes(key));

const isOptionalString = (value: unknown): boolean => value === undefined || typeof value === 'string';
const isOptionalFiniteNumber = (value: unknown): boolean => value === undefined || (typeof value === 'number' && Number.isFinite(value));

export const isExternalWalletSnapshotResponse = (value: unknown): value is ExternalWalletSnapshotResponse => {
  if (!isRecord(value) || !hasOnlyKeys(value, ['success', 'entityId', 'owner', 'blockNumber', 'blockHash', 'sourceHeight', 'sourceHash', 'finalityDepth', 'headBlockNumber', 'transactionHash', 'nativeBalance', 'tokenBalances', 'allowances', 'tokenErrors', 'allowanceErrors', 'error'])) return false;
  if (value['success'] !== undefined && typeof value['success'] !== 'boolean') return false;
  for (const field of ['entityId', 'owner', 'blockHash', 'sourceHash', 'transactionHash', 'nativeBalance', 'error'] as const) if (!isOptionalString(value[field])) return false;
  for (const field of ['blockNumber', 'sourceHeight', 'finalityDepth', 'headBlockNumber'] as const) if (!isOptionalFiniteNumber(value[field])) return false;
  const tokenBalances = value['tokenBalances'];
  const allowances = value['allowances'];
  const tokenErrors = value['tokenErrors'];
  const allowanceErrors = value['allowanceErrors'];
  return (tokenBalances === undefined || (Array.isArray(tokenBalances) && tokenBalances.every((entry) => isRecord(entry) && hasOnlyKeys(entry, ['tokenAddress', 'tokenId', 'balance', 'error']) && isOptionalString(entry['tokenAddress']) && isOptionalFiniteNumber(entry['tokenId']) && isOptionalString(entry['balance']) && isOptionalString(entry['error'])))) &&
    (allowances === undefined || (Array.isArray(allowances) && allowances.every((entry) => isRecord(entry) && hasOnlyKeys(entry, ['tokenAddress', 'spender', 'allowance', 'error']) && isOptionalString(entry['tokenAddress']) && isOptionalString(entry['spender']) && isOptionalString(entry['allowance']) && isOptionalString(entry['error'])))) &&
    (tokenErrors === undefined || (Array.isArray(tokenErrors) && tokenErrors.every((entry) => isRecord(entry) && hasOnlyKeys(entry, ['tokenAddress', 'error']) && isOptionalString(entry['tokenAddress']) && isOptionalString(entry['error'])))) &&
    (allowanceErrors === undefined || (Array.isArray(allowanceErrors) && allowanceErrors.every((entry) => isRecord(entry) && hasOnlyKeys(entry, ['tokenAddress', 'spender', 'error']) && isOptionalString(entry['tokenAddress']) && isOptionalString(entry['spender']) && isOptionalString(entry['error']))));
};

export const decodeExternalWalletSnapshotResponse = (value: unknown): ExternalWalletSnapshotResponse => {
  if (!isExternalWalletSnapshotResponse(value)) throw new Error('EXTERNAL_WALLET_SNAPSHOT_RESPONSE_INVALID');
  return value;
};

export function resolveExternalWalletSnapshotIngress(
  expectedRuntimeId: string,
  currentEnv: RuntimeReplica | null,
): ExternalWalletSnapshotIngressDecision {
  const expected = expectedRuntimeId.trim().toLowerCase();
  if (!expected) throw new Error('EXTERNAL_WALLET_SNAPSHOT_RUNTIME_ID_MISSING');
  if (String(currentEnv?.runtimeId || '').trim().toLowerCase() !== expected) {
    return 'cancel-runtime-changed';
  }
  if (
    currentEnv?.infrastructure?.persistenceQuiescing === true ||
    currentEnv?.infrastructure?.lifecyclePhase === 'quiescing'
  ) {
    return 'cancel-runtime-quiescing';
  }
  return 'apply';
}

export function requireExternalSnapshotBigInt(value: bigint | null | undefined, label: string): bigint {
  if (typeof value !== 'bigint') {
    throw new Error(`EXTERNAL_WALLET_SNAPSHOT_FIELD_MISSING:${label}`);
  }
  return value;
}

export function assertExternalSnapshotCount(values: unknown[], expected: number, label: string): void {
  if (values.length !== expected) {
    throw new Error(`EXTERNAL_WALLET_SNAPSHOT_FIELD_COUNT_MISMATCH:${label}:expected=${expected}:actual=${values.length}`);
  }
}

export function normalizeOptionalTokenId(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value;
  if (typeof value === 'bigint') {
    const numeric = Number(value);
    return Number.isSafeInteger(numeric) && numeric >= 0 ? numeric : undefined;
  }
  if (typeof value === 'string' && value.trim().length > 0) {
    const numeric = Number(value.trim());
    return Number.isSafeInteger(numeric) && numeric >= 0 ? numeric : undefined;
  }
  return undefined;
}

export function resolveExternalWalletFinalityDepth(jadapter: JAdapter): number {
  const rawDepth = Number(jadapter.getFinalityDepth?.() ?? 0);
  if (!Number.isFinite(rawDepth) || rawDepth < 0) {
    throw new Error(`EXTERNAL_WALLET_SNAPSHOT_FINALITY_INVALID:${String(rawDepth)}`);
  }
  return Math.floor(rawDepth);
}

export async function readExternalWalletSnapshotSource(
  jadapter: JAdapter,
): Promise<ResolvedExternalWalletSnapshotSource> {
  const headBlockNumber = Number(await (jadapter.getCurrentBlockNumber?.() ?? jadapter.provider.getBlockNumber()));
  if (!Number.isFinite(headBlockNumber) || !Number.isInteger(headBlockNumber) || headBlockNumber < 0) {
    throw new Error(`EXTERNAL_WALLET_SNAPSHOT_HEAD_INVALID:${String(headBlockNumber)}`);
  }
  const finalityDepth = resolveExternalWalletFinalityDepth(jadapter);
  const sourceHeight = headBlockNumber - finalityDepth;
  if (sourceHeight < 0) {
    throw new Error(`EXTERNAL_WALLET_SNAPSHOT_FINALITY_UNAVAILABLE:head=${headBlockNumber}:depth=${finalityDepth}`);
  }
  const block = await jadapter.provider.getBlock(sourceHeight);
  if (!block?.hash) {
    throw new Error(`EXTERNAL_WALLET_SNAPSHOT_BLOCK_HASH_MISSING:${sourceHeight}`);
  }
  return {
    headBlockNumber,
    sourceHeight,
    sourceHash: block.hash,
    finalityDepth,
  };
}
