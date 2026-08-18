import { ethers } from 'ethers';
import type { JAdapter, JWalletAllowanceRead } from '../../../jurisdiction/adapter/types';
import { createStructuredLogger } from '../../../support/logger';
import { safeStringify } from '../../../protocol/serialization';
import { requireBoundaryRecord, requireExactBoundaryKeys } from '../../../protocol/boundary-validation';

export const MAX_WALLET_SNAPSHOT_BODY_BYTES = 32 * 1024;
export const MAX_WALLET_SNAPSHOT_TOKEN_ADDRESSES = 128;
const MAX_WALLET_SNAPSHOT_ALLOWANCES = 128;

/** Stream-counted admission errors are safe to expose as typed 400/413 responses. */
export class RequestBodyError extends Error {
  constructor(
    readonly status: 400 | 413,
    readonly code: string,
    details: string,
  ) {
    super(`${code}:${details}`);
    this.name = 'RequestBodyError';
  }
}

export const readCappedRequestText = async (
  request: Request,
  maxBytes: number,
  codePrefix: string,
): Promise<string> => {
  const declared = Number(request.headers.get('content-length') || '');
  if (Number.isSafeInteger(declared) && declared > maxBytes) {
    throw new RequestBodyError(413, `${codePrefix}_BODY_TOO_LARGE`, `bytes=${declared}:max=${maxBytes}`);
  }
  if (!request.body) return '';
  const reader = request.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let text = '';
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        throw new RequestBodyError(413, `${codePrefix}_BODY_TOO_LARGE`, `bytes>${maxBytes}`);
      }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    if (error instanceof RequestBodyError) throw error;
    throw new RequestBodyError(400, `${codePrefix}_JSON_INVALID`, 'invalid-utf8');
  }
};

const parseCappedJsonRecord = async (
  request: Request,
  maxBytes: number,
  codePrefix: string,
): Promise<Record<string, unknown>> => {
  const raw = await readCappedRequestText(request, maxBytes, codePrefix);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new RequestBodyError(400, `${codePrefix}_JSON_INVALID`, 'expected-object');
  }
  try {
    return requireBoundaryRecord(parsed, `${codePrefix}_BODY_INVALID`);
  } catch {
    throw new RequestBodyError(400, `${codePrefix}_BODY_INVALID`, 'expected-object');
  }
};

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
  const body = await parseCappedJsonRecord(request, MAX_WALLET_SNAPSHOT_BODY_BYTES, 'FAUCET');
  requireExactBoundaryKeys(body, ['userAddress'], ['tokenSymbol', 'amount'], 'FAUCET_BODY_FIELDS_INVALID');
  return {
    userAddress: String(body['userAddress'] || '').trim(),
    tokenSymbol: String(body['tokenSymbol'] || 'USDC')
      .trim()
      .toUpperCase(),
    amount: String(body['amount'] || '100').trim(),
  };
};

export const readGasFaucetBody = async (request: Request): Promise<GasFaucetRequestBody> => {
  const body = await parseCappedJsonRecord(request, MAX_WALLET_SNAPSHOT_BODY_BYTES, 'GAS_FAUCET');
  requireExactBoundaryKeys(body, ['userAddress'], ['amount'], 'GAS_FAUCET_BODY_FIELDS_INVALID');
  return {
    userAddress: String(body['userAddress'] || '').trim(),
    amount: String(body['amount'] || '0.1').trim(),
  };
};

const requireSnapshotString = (value: unknown, label: string): string => {
  if (typeof value !== 'string') {
    throw new RequestBodyError(400, 'EXTERNAL_WALLET_SNAPSHOT_FIELD_INVALID', label);
  }
  return value.trim();
};

const normalizeSnapshotAddress = (value: unknown, label: string): string => {
  const raw = requireSnapshotString(value, label);
  if (!ethers.isAddress(raw)) {
    throw new RequestBodyError(400, 'EXTERNAL_WALLET_SNAPSHOT_ADDRESS_INVALID', label);
  }
  return ethers.getAddress(raw).toLowerCase();
};

const requireSnapshotArray = (
  body: Record<string, unknown>,
  key: 'tokenAddresses' | 'allowances',
  maximum: number,
): unknown[] | undefined => {
  if (!(key in body)) return undefined;
  const values = body[key];
  if (!Array.isArray(values)) {
    throw new RequestBodyError(400, 'EXTERNAL_WALLET_SNAPSHOT_FIELD_INVALID', key);
  }
  if (values.length > maximum) {
    throw new RequestBodyError(413, 'EXTERNAL_WALLET_SNAPSHOT_CARDINALITY_EXCEEDED', `${key}:max=${maximum}`);
  }
  return values;
};

export const normalizeWalletSnapshotTokenAddresses = (
  values: readonly unknown[],
  label = 'tokenAddresses',
): string[] => {
  if (values.length > MAX_WALLET_SNAPSHOT_TOKEN_ADDRESSES) {
    throw new RequestBodyError(
      413,
      'EXTERNAL_WALLET_SNAPSHOT_CARDINALITY_EXCEEDED',
      `${label}:max=${MAX_WALLET_SNAPSHOT_TOKEN_ADDRESSES}`,
    );
  }
  const seen = new Set<string>();
  return values.map((value, index) => {
    const address = normalizeSnapshotAddress(value, `${label}[${index}]`);
    if (seen.has(address)) {
      throw new RequestBodyError(400, 'EXTERNAL_WALLET_SNAPSHOT_DUPLICATE', `${label}:${address}`);
    }
    seen.add(address);
    return address;
  });
};

export const readWalletSnapshotBody = async (request: Request): Promise<WalletSnapshotRequestBody> => {
  const body = await parseCappedJsonRecord(
    request,
    MAX_WALLET_SNAPSHOT_BODY_BYTES,
    'EXTERNAL_WALLET_SNAPSHOT',
  );
  const rawTokens = requireSnapshotArray(body, 'tokenAddresses', MAX_WALLET_SNAPSHOT_TOKEN_ADDRESSES);
  const rawAllowances = requireSnapshotArray(body, 'allowances', MAX_WALLET_SNAPSHOT_ALLOWANCES);
  const tokenAddresses = rawTokens
    ? normalizeWalletSnapshotTokenAddresses(rawTokens)
    : undefined;
  const allowanceKeys = new Set<string>();
  const allowances = rawAllowances?.map((value, index) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new RequestBodyError(400, 'EXTERNAL_WALLET_SNAPSHOT_FIELD_INVALID', `allowances[${index}]`);
    }
    const entry = requireBoundaryRecord(value, 'EXTERNAL_WALLET_SNAPSHOT_ALLOWANCE_INVALID');
    requireExactBoundaryKeys(entry, ['tokenAddress', 'spender'], [], 'EXTERNAL_WALLET_SNAPSHOT_ALLOWANCE_FIELDS_INVALID');
    const tokenAddress = normalizeSnapshotAddress(
      entry['tokenAddress'],
      `allowances[${index}].tokenAddress`,
    );
    const spender = normalizeSnapshotAddress(entry['spender'], `allowances[${index}].spender`);
    const key = `${tokenAddress}:${spender}`;
    if (allowanceKeys.has(key)) {
      throw new RequestBodyError(400, 'EXTERNAL_WALLET_SNAPSHOT_DUPLICATE', `allowances:${key}`);
    }
    allowanceKeys.add(key);
    return { tokenAddress, spender };
  });
  return {
    entityId: requireSnapshotString(body['entityId'], 'entityId').toLowerCase(),
    owner: requireSnapshotString(body['owner'], 'owner'),
    ...(tokenAddresses ? { tokenAddresses } : {}),
    ...(allowances ? { allowances } : {}),
  };
};
