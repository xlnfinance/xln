export const RESERVE_FAUCET_TIMEOUT_MS = 15_000;
export const OFFCHAIN_FAUCET_TIMEOUT_MS = 15_000;

export type FaucetApiResult = {
  success?: boolean;
  error?: string;
  code?: string;
  details?: unknown;
  requestId?: string;
  serverDurationMs?: number;
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
