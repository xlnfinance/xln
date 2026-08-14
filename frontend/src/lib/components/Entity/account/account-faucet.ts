export const RESERVE_FAUCET_TIMEOUT_MS = 15_000;
export const OFFCHAIN_FAUCET_REQUEST_TIMEOUT_MS = 3_000;

export type FaucetApiResult = {
  success?: boolean;
  status?: string;
  error?: string;
  code?: string;
  details?: unknown;
  requestId?: string;
  statusUrl?: string;
  receipt?: {
    id?: string | null;
    status?: string;
    counts?: {
      runtimeTxs?: number;
      entityInputs?: number;
      jInputs?: number;
    };
    enqueuedHeight?: number | null;
    observedHeight?: number | null;
    note?: string | null;
  };
  accountReady?: boolean;
  serverDurationMs?: number;
  events?: Array<{
    name: string;
    args: Record<string, unknown>;
    blockNumber: number;
    blockHash: string;
    transactionHash: string;
  }>;
};

export type PendingReserveFaucet = {
  tokenId: number;
  amount: bigint;
  expectedBalance: bigint;
  startedAt: number;
  symbol: string;
};

export type ReserveFaucetCompletion = {
  req: PendingReserveFaucet;
  currentBalance: bigint;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const hasOnlyKeys = (value: Record<string, unknown>, allowed: readonly string[]): boolean =>
  Object.keys(value).every((key) => allowed.includes(key));

const isFaucetReceipt = (value: unknown): value is NonNullable<FaucetApiResult['receipt']> => {
  if (!isRecord(value) || !hasOnlyKeys(value, ['id', 'status', 'counts', 'enqueuedHeight', 'observedHeight', 'note'])) return false;
  if (value['id'] !== undefined && value['id'] !== null && typeof value['id'] !== 'string') return false;
  if (value['status'] !== undefined && typeof value['status'] !== 'string') return false;
  if (value['enqueuedHeight'] !== undefined && value['enqueuedHeight'] !== null && (typeof value['enqueuedHeight'] !== 'number' || !Number.isFinite(value['enqueuedHeight']))) return false;
  if (value['observedHeight'] !== undefined && value['observedHeight'] !== null && (typeof value['observedHeight'] !== 'number' || !Number.isFinite(value['observedHeight']))) return false;
  if (value['note'] !== undefined && value['note'] !== null && typeof value['note'] !== 'string') return false;
  const counts = value['counts'];
  return counts === undefined || (isRecord(counts) && hasOnlyKeys(counts, ['runtimeTxs', 'entityInputs', 'jInputs']) &&
    Object.values(counts).every((count) => typeof count === 'number' && Number.isFinite(count)));
};

export const isFaucetApiResult = (value: unknown): value is FaucetApiResult => {
  if (!isRecord(value) || !hasOnlyKeys(value, ['success', 'status', 'error', 'code', 'details', 'requestId', 'statusUrl', 'receipt', 'accountReady', 'serverDurationMs', 'events'])) return false;
  if (value['success'] !== undefined && typeof value['success'] !== 'boolean') return false;
  for (const field of ['status', 'error', 'code', 'requestId', 'statusUrl'] as const) if (value[field] !== undefined && typeof value[field] !== 'string') return false;
  if (value['accountReady'] !== undefined && typeof value['accountReady'] !== 'boolean') return false;
  if (value['serverDurationMs'] !== undefined && (typeof value['serverDurationMs'] !== 'number' || !Number.isFinite(value['serverDurationMs']))) return false;
  if (value['receipt'] !== undefined && !isFaucetReceipt(value['receipt'])) return false;
  if (!Array.isArray(value['events']) && value['events'] !== undefined) return false;
  return value['events'] === undefined || value['events'].every((event) => isRecord(event) && hasOnlyKeys(event, ['name', 'args', 'blockNumber', 'blockHash', 'transactionHash']) &&
    typeof event['name'] === 'string' && isRecord(event['args']) && typeof event['blockNumber'] === 'number' && Number.isFinite(event['blockNumber']) &&
    typeof event['blockHash'] === 'string' && typeof event['transactionHash'] === 'string');
};

export const decodeFaucetApiResult = (value: unknown): FaucetApiResult => {
  if (!isFaucetApiResult(value)) throw new Error('FAUCET_RESPONSE_INVALID');
  return value;
};

export async function readJsonResponse(response: Response): Promise<unknown | null> {
  const raw = await response.text();
  if (!raw) return null;
  try {
    return parseJsonUnknown(raw, 'FAUCET_RESPONSE_JSON_INVALID');
  } catch {
    return null;
  }
}

export async function readFaucetApiResult(response: Response): Promise<FaucetApiResult | null> {
  const value = await readJsonResponse(response);
  return value === null ? null : decodeFaucetApiResult(value);
}

export function faucetPendingKey(hubEntityId: string, tokenId: number): string {
  return `${String(hubEntityId || '').toLowerCase()}:${Math.floor(Number(tokenId) || 0)}`;
}

export function reconcilePendingReserveFaucets(
  pending: PendingReserveFaucet[],
  now: number,
  getCurrentBalance: (tokenId: number) => bigint,
): {
  remaining: PendingReserveFaucet[];
  received: ReserveFaucetCompletion[];
  timedOut: PendingReserveFaucet[];
} {
  const remaining: PendingReserveFaucet[] = [];
  const received: ReserveFaucetCompletion[] = [];
  const timedOut: PendingReserveFaucet[] = [];
  for (const req of pending) {
    const currentBalance = getCurrentBalance(req.tokenId);
    if (currentBalance >= req.expectedBalance) {
      received.push({ req, currentBalance });
    } else if (now - req.startedAt > RESERVE_FAUCET_TIMEOUT_MS) {
      timedOut.push(req);
    } else {
      remaining.push(req);
    }
  }
  return { remaining, received, timedOut };
}
import { parseJsonUnknown } from '$lib/utils/boundary';
