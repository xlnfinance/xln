import { hasOnlyAllowedKeys as hasOnlyKeys, isUnknownRecord as isRecord, parseJsonUnknown } from '$lib/utils/boundary';

export const RESERVE_FAUCET_TIMEOUT_MS = 15_000;
export const OFFCHAIN_FAUCET_REQUEST_TIMEOUT_MS = 3_000;

export type FaucetApiResult = {
  success?: boolean;
  status?: string;
  error?: string;
  code?: string;
  details?: unknown;
  requestId?: string;
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

export const isFaucetApiResult = (value: unknown): value is FaucetApiResult => {
  // Server responses (success and failure bodies) carry additional diagnostic
  // fields (type, amount, tokenId, from, to, accountState, senderOutCapacity,
  // category, retryable, fatal, failure, and an open-ended `extra` bag) that
  // this client does not read. Validate the fields we do use; do not reject
  // on unknown extra keys, or every server-side field addition breaks this.
  if (!isRecord(value)) return false;
  if (value['success'] !== undefined && typeof value['success'] !== 'boolean') return false;
  for (const field of ['status', 'error', 'code', 'requestId'] as const) if (value[field] !== undefined && typeof value[field] !== 'string') return false;
  if (value['accountReady'] !== undefined && typeof value['accountReady'] !== 'boolean') return false;
  if (value['serverDurationMs'] !== undefined && (typeof value['serverDurationMs'] !== 'number' || !Number.isFinite(value['serverDurationMs']))) return false;
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
