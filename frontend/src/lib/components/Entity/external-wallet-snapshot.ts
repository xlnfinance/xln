import type { JAdapter } from '@xln/runtime/xln-api';
import type { ExternalWalletSnapshotSource } from './asset-ledger';

export type { ExternalWalletSnapshotSource } from './asset-ledger';

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
