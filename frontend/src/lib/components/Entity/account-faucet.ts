export const RESERVE_FAUCET_TIMEOUT_MS = 15_000;
export const OFFCHAIN_FAUCET_TIMEOUT_MS = 15_000;
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

export type PendingOffchainFaucet = {
  hubEntityId: string;
  tokenId: number;
  amount: bigint;
  baselineOut: bigint;
  expectedOut: bigint;
  startedAt: number;
  symbol: string;
  requestId?: string;
  status?: 'queued';
  statusUrl?: string;
  accountReady?: boolean;
};

export type ReserveFaucetCompletion = {
  req: PendingReserveFaucet;
  currentBalance: bigint;
};

export type OffchainFaucetCompletion = {
  req: PendingOffchainFaucet;
  currentOut: bigint;
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

export function attachOffchainFaucetRequestId(
  pending: PendingOffchainFaucet[],
  pendingKey: string,
  requestId: string | undefined,
): PendingOffchainFaucet[] {
  if (!requestId) return pending;
  return pending.map((req) =>
    faucetPendingKey(req.hubEntityId, req.tokenId) === pendingKey ? { ...req, requestId } : req,
  );
}

export function attachOffchainFaucetReceipt(
  pending: PendingOffchainFaucet[],
  pendingKey: string,
  result: Pick<FaucetApiResult, 'requestId' | 'status' | 'statusUrl' | 'accountReady'> | null | undefined,
): PendingOffchainFaucet[] {
  if (!result?.requestId) return pending;
  const requestId = result.requestId;
  return pending.map((req) => {
    if (faucetPendingKey(req.hubEntityId, req.tokenId) !== pendingKey) return req;
    return {
      ...req,
      requestId,
      ...(result.status === 'queued' ? { status: 'queued' as const } : {}),
      ...(result.statusUrl ? { statusUrl: result.statusUrl } : {}),
      ...(typeof result.accountReady === 'boolean' ? { accountReady: result.accountReady } : {}),
    };
  });
}

export function removeOffchainFaucet(
  pending: PendingOffchainFaucet[],
  hubEntityId: string,
  tokenId: number,
): PendingOffchainFaucet[] {
  const key = faucetPendingKey(hubEntityId, tokenId);
  return pending.filter((req) => faucetPendingKey(req.hubEntityId, req.tokenId) !== key);
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

export function reconcilePendingOffchainFaucets(
  pending: PendingOffchainFaucet[],
  now: number,
  getCurrentOut: (req: PendingOffchainFaucet) => bigint,
): {
  remaining: PendingOffchainFaucet[];
  received: OffchainFaucetCompletion[];
  timedOut: PendingOffchainFaucet[];
} {
  const remaining: PendingOffchainFaucet[] = [];
  const received: OffchainFaucetCompletion[] = [];
  const timedOut: PendingOffchainFaucet[] = [];
  for (const req of pending) {
    const currentOut = getCurrentOut(req);
    if (currentOut >= req.expectedOut || currentOut > req.baselineOut) {
      received.push({ req, currentOut });
    } else if (now - req.startedAt > OFFCHAIN_FAUCET_TIMEOUT_MS) {
      timedOut.push(req);
    } else {
      remaining.push(req);
    }
  }
  return { remaining, received, timedOut };
}
