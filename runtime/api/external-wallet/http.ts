import { ethers } from 'ethers';
import type { JAdapter, JWalletAllowanceRead } from '../../jurisdiction/adapter/types';
import { createStructuredLogger } from '../../infra/logger';
import { safeStringify } from '../../protocol/serialization';

export interface FaucetRequestBody {
  userAddress: string;
  tokenSymbol: string;
  amount: string;
}

export interface GasFaucetRequestBody {
  userAddress: string;
  amount: string;
}

export interface WalletSnapshotRequestBody {
  entityId: string;
  owner: string;
  tokenAddresses?: string[];
  allowances?: JWalletAllowanceRead[];
}

export const externalWalletLog = createStructuredLogger('server.external_wallet');

export const createJsonResponse = (headers: Record<string, string>, payload: unknown, status = 200): Response =>
  new Response(safeStringify(payload), {
    status,
    headers,
  });

export const requireSnapshotBigInt = (value: unknown, label: string): bigint => {
  if (typeof value !== 'bigint') {
    throw new Error(`EXTERNAL_WALLET_SNAPSHOT_FIELD_MISSING:${label}`);
  }
  return value;
};

export const assertSnapshotArrayLength = (values: unknown, expected: number, label: string): void => {
  if (!Array.isArray(values) || values.length !== expected) {
    throw new Error(
      `EXTERNAL_WALLET_SNAPSHOT_FIELD_COUNT_MISMATCH:${label}:expected=${expected}:actual=${
        Array.isArray(values) ? values.length : 'non-array'
      }`,
    );
  }
};

const resolveSnapshotFinalityDepth = (adapter: JAdapter): number => {
  const rawDepth = Number(adapter.getFinalityDepth?.() ?? 0);
  if (!Number.isFinite(rawDepth) || rawDepth < 0) {
    throw new Error(`EXTERNAL_WALLET_SNAPSHOT_FINALITY_INVALID:${String(rawDepth)}`);
  }
  return Math.floor(rawDepth);
};

export const readExternalWalletSnapshotSource = async (
  adapter: JAdapter,
): Promise<{
  headBlockNumber: number;
  sourceHeight: number;
  sourceHash: string;
  finalityDepth: number;
}> => {
  const headBlockNumber = Number(await (adapter.getCurrentBlockNumber?.() ?? adapter.provider.getBlockNumber()));
  if (!Number.isSafeInteger(headBlockNumber) || headBlockNumber < 0) {
    throw new Error(`EXTERNAL_WALLET_SNAPSHOT_HEAD_INVALID:${String(headBlockNumber)}`);
  }
  const finalityDepth = resolveSnapshotFinalityDepth(adapter);
  const sourceHeight = headBlockNumber - finalityDepth;
  if (sourceHeight < 0) {
    throw new Error(`EXTERNAL_WALLET_SNAPSHOT_FINALITY_UNAVAILABLE:head=${headBlockNumber}:depth=${finalityDepth}`);
  }
  const block = await adapter.provider.getBlock(sourceHeight);
  if (!block?.hash) throw new Error(`EXTERNAL_WALLET_SNAPSHOT_BLOCK_HASH_MISSING:${sourceHeight}`);
  return { headBlockNumber, sourceHeight, sourceHash: block.hash, finalityDepth };
};

export const readFaucetBody = async (request: Request): Promise<FaucetRequestBody> => {
  const body = (await request.json()) as Record<string, unknown>;
  return {
    userAddress: String(body['userAddress'] || '').trim(),
    tokenSymbol: String(body['tokenSymbol'] || 'USDC')
      .trim()
      .toUpperCase(),
    amount: String(body['amount'] || '100').trim(),
  };
};

export const readGasFaucetBody = async (request: Request): Promise<GasFaucetRequestBody> => {
  const body = (await request.json()) as Record<string, unknown>;
  return {
    userAddress: String(body['userAddress'] || '').trim(),
    amount: String(body['amount'] || '0.1').trim(),
  };
};

export const readWalletSnapshotBody = async (request: Request): Promise<WalletSnapshotRequestBody> => {
  const body = (await request.json()) as Record<string, unknown>;
  const tokenAddresses = Array.isArray(body['tokenAddresses'])
    ? body['tokenAddresses'].map(value => String(value || '').trim()).filter(Boolean)
    : undefined;
  const allowances = Array.isArray(body['allowances'])
    ? body['allowances']
        .map(value => {
          const entry = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
          return {
            tokenAddress: String(entry['tokenAddress'] || '').trim(),
            spender: String(entry['spender'] || '').trim(),
          };
        })
        .filter(entry => ethers.isAddress(entry.tokenAddress) && ethers.isAddress(entry.spender))
    : undefined;
  return {
    entityId: String(body['entityId'] || '')
      .trim()
      .toLowerCase(),
    owner: String(body['owner'] || '').trim(),
    ...(tokenAddresses ? { tokenAddresses } : {}),
    ...(allowances ? { allowances } : {}),
  };
};
