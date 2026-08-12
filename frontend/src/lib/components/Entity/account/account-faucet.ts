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

export async function readJsonResponse<T = unknown>(response: Response): Promise<T | null> {
  const raw = await response.text();
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
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
