import type { Env, RuntimeInput } from '../types';
import { normalizeInterestBps, normalizeLendingTerm, selectBestLendingPool, summarizeLendingState } from '../lending';
import { safeStringify } from '../serialization-utils';
import { resolveEntityProposerId } from '../state-helpers';
import { isEntityId32 } from '../server-utils';
import { getAccountMachine, getEntityReplicaById, hasAccount } from './entity-lookup';

type LendingApiInput = {
  req: Request;
  env: Env | null;
  headers: HeadersInit;
  activeHubEntityIds: string[];
  enqueueRuntimeInput: (env: Env, runtimeInput: RuntimeInput) => void;
};

const parseJsonBody = async (req: Request): Promise<Record<string, unknown>> => {
  const raw = await req.json().catch(() => null);
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
};

const parseAmount = (value: unknown): bigint | null => {
  const raw = typeof value === 'string' ? value.trim() : String(value ?? '').trim();
  if (!/^\d+$/.test(raw)) return null;
  const amount = BigInt(raw);
  return amount > 0n ? amount : null;
};

const parseTokenId = (value: unknown): number | null => {
  const tokenId = Math.floor(Number(value ?? 1));
  return Number.isFinite(tokenId) && tokenId > 0 ? tokenId : null;
};

const bigintFieldsToStrings = <T>(value: T): unknown => {
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return value.map(bigintFieldsToStrings);
  if (!value || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    out[key] = bigintFieldsToStrings(entry);
  }
  return out;
};

const resolveHub = (
  env: Env,
  activeHubEntityIds: string[],
  rawHubEntityId: unknown,
): { hubEntityId: string; error?: Response } => {
  const requested = typeof rawHubEntityId === 'string' ? rawHubEntityId.toLowerCase() : '';
  if (!isEntityId32(requested)) {
    return {
      hubEntityId: '',
      error: new Response(safeStringify({ success: false, error: 'Invalid hubEntityId' }), { status: 400 }),
    };
  }
  const allowed = new Set(activeHubEntityIds.map(value => value.toLowerCase()).filter(Boolean));
  const replica = getEntityReplicaById(env, requested);
  if (!replica || (allowed.size > 0 && !allowed.has(requested))) {
    return {
      hubEntityId: requested,
      error: new Response(
        safeStringify({ success: false, error: 'Requested hub is not available', hubEntityId: requested }),
        { status: 404 },
      ),
    };
  }
  return { hubEntityId: requested };
};

const responseWithHeaders = (response: Response, headers: HeadersInit): Response =>
  new Response(response.body, { status: response.status, statusText: response.statusText, headers });

export const handleLendingStateRequest = async (input: {
  req: Request;
  env: Env | null;
  headers: HeadersInit;
  activeHubEntityIds: string[];
}): Promise<Response> => {
  const { req, env, headers } = input;
  if (!env) return new Response(safeStringify({ success: false, error: 'Runtime not initialized' }), { status: 503, headers });
  const url = new URL(req.url);
  const hub = resolveHub(env, input.activeHubEntityIds, url.searchParams.get('hubEntityId'));
  if (hub.error) return responseWithHeaders(hub.error, headers);
  const tokenId = url.searchParams.has('tokenId') ? parseTokenId(url.searchParams.get('tokenId')) : undefined;
  if (tokenId === null) {
    return new Response(safeStringify({ success: false, error: 'Invalid tokenId' }), { status: 400, headers });
  }
  const userEntityId = String(url.searchParams.get('userEntityId') || '').toLowerCase();
  if (userEntityId && !isEntityId32(userEntityId)) {
    return new Response(safeStringify({ success: false, error: 'Invalid userEntityId' }), { status: 400, headers });
  }
  const replica = getEntityReplicaById(env, hub.hubEntityId);
  const summary = summarizeLendingState(replica!.state, {
    ...(userEntityId ? { userEntityId } : {}),
    ...(tokenId !== undefined ? { tokenId } : {}),
  });
  return new Response(safeStringify({
    success: true,
    hubEntityId: hub.hubEntityId,
    ...bigintFieldsToStrings(summary) as Record<string, unknown>,
  }), { headers });
};

export const handleLendingOfferRequest = async (input: LendingApiInput): Promise<Response> => {
  const { req, env, headers } = input;
  if (!env) return new Response(safeStringify({ success: false, error: 'Runtime not initialized' }), { status: 503, headers });
  const body = await parseJsonBody(req);
  const lenderEntityId = typeof body['lenderEntityId'] === 'string' ? body['lenderEntityId'].toLowerCase() : '';
  if (!isEntityId32(lenderEntityId)) {
    return new Response(safeStringify({ success: false, error: 'Invalid lenderEntityId' }), { status: 400, headers });
  }
  const hub = resolveHub(env, input.activeHubEntityIds, body['hubEntityId']);
  if (hub.error) return responseWithHeaders(hub.error, headers);
  if (!hasAccount(env, hub.hubEntityId, lenderEntityId)) {
    return new Response(safeStringify({ success: false, error: 'Open an account with this hub first' }), { status: 409, headers });
  }
  const tokenId = parseTokenId(body['tokenId']);
  const amount = parseAmount(body['amount']);
  if (tokenId === null || amount === null) {
    return new Response(safeStringify({ success: false, error: 'Invalid token or amount' }), { status: 400, headers });
  }
  let termId;
  let interestBps;
  try {
    termId = normalizeLendingTerm(body['termId']);
    interestBps = normalizeInterestBps(body['interestBps']);
  } catch (error) {
    return new Response(safeStringify({ success: false, error: error instanceof Error ? error.message : String(error) }), { status: 400, headers });
  }
  const signerId = resolveEntityProposerId(env, hub.hubEntityId, 'lending-offer');
  input.enqueueRuntimeInput(env, {
    runtimeTxs: [],
    entityInputs: [{
      entityId: hub.hubEntityId,
      signerId,
      entityTxs: [{
        type: 'lendingOffer',
        data: { lenderEntityId, tokenId, amount, termId, interestBps },
      }],
    }],
  });
  return new Response(safeStringify({ success: true, hubEntityId: hub.hubEntityId, lenderEntityId, tokenId, amount: amount.toString(), termId, interestBps }), { headers });
};

export const handleLendingBorrowRequest = async (input: LendingApiInput): Promise<Response> => {
  const { req, env, headers } = input;
  if (!env) return new Response(safeStringify({ success: false, error: 'Runtime not initialized' }), { status: 503, headers });
  const body = await parseJsonBody(req);
  const borrowerEntityId = typeof body['borrowerEntityId'] === 'string' ? body['borrowerEntityId'].toLowerCase() : '';
  if (!isEntityId32(borrowerEntityId)) {
    return new Response(safeStringify({ success: false, error: 'Invalid borrowerEntityId' }), { status: 400, headers });
  }
  const hub = resolveHub(env, input.activeHubEntityIds, body['hubEntityId']);
  if (hub.error) return responseWithHeaders(hub.error, headers);
  const account = getAccountMachine(env, hub.hubEntityId, borrowerEntityId);
  if (!account) {
    return new Response(safeStringify({ success: false, error: 'Open an account with this hub first' }), { status: 409, headers });
  }
  const tokenId = parseTokenId(body['tokenId']);
  const amount = parseAmount(body['amount']);
  if (tokenId === null || amount === null) {
    return new Response(safeStringify({ success: false, error: 'Invalid token or amount' }), { status: 400, headers });
  }
  if (!account.deltas.has(tokenId)) {
    return new Response(safeStringify({ success: false, error: 'Token is not enabled on this account' }), { status: 409, headers });
  }
  let termId;
  let maxInterestBps;
  try {
    termId = normalizeLendingTerm(body['termId']);
    maxInterestBps = normalizeInterestBps(body['maxInterestBps'] ?? 10_000);
  } catch (error) {
    return new Response(safeStringify({ success: false, error: error instanceof Error ? error.message : String(error) }), { status: 400, headers });
  }
  const hubReplica = getEntityReplicaById(env, hub.hubEntityId)!;
  const lending = hubReplica.state.lending ?? { pools: new Map(), loans: new Map() };
  const pool = selectBestLendingPool(lending, tokenId, amount, termId, maxInterestBps);
  if (!pool) {
    return new Response(safeStringify({ success: false, error: 'No lending liquidity for requested term/token' }), { status: 409, headers });
  }
  const signerId = resolveEntityProposerId(env, hub.hubEntityId, 'lending-borrow');
  input.enqueueRuntimeInput(env, {
    runtimeTxs: [],
    entityInputs: [{
      entityId: hub.hubEntityId,
      signerId,
      entityTxs: [{
        type: 'lendingBorrow',
        data: { borrowerEntityId, tokenId, amount, termId, maxInterestBps },
      }],
    }],
  });
  return new Response(safeStringify({ success: true, hubEntityId: hub.hubEntityId, borrowerEntityId, tokenId, amount: amount.toString(), termId, maxInterestBps }), { headers });
};

export const handleLendingRepayRequest = async (input: LendingApiInput): Promise<Response> => {
  const { req, env, headers } = input;
  if (!env) return new Response(safeStringify({ success: false, error: 'Runtime not initialized' }), { status: 503, headers });
  const body = await parseJsonBody(req);
  const borrowerEntityId = typeof body['borrowerEntityId'] === 'string' ? body['borrowerEntityId'].toLowerCase() : '';
  const loanId = typeof body['loanId'] === 'string' ? body['loanId'] : '';
  if (!isEntityId32(borrowerEntityId) || !loanId) {
    return new Response(safeStringify({ success: false, error: 'Invalid borrowerEntityId or loanId' }), { status: 400, headers });
  }
  const hub = resolveHub(env, input.activeHubEntityIds, body['hubEntityId']);
  if (hub.error) return responseWithHeaders(hub.error, headers);
  const amount = body['amount'] === undefined ? undefined : parseAmount(body['amount']);
  if (body['amount'] !== undefined && amount === null) {
    return new Response(safeStringify({ success: false, error: 'Invalid amount' }), { status: 400, headers });
  }
  const signerId = resolveEntityProposerId(env, hub.hubEntityId, 'lending-repay');
  input.enqueueRuntimeInput(env, {
    runtimeTxs: [],
    entityInputs: [{
      entityId: hub.hubEntityId,
      signerId,
      entityTxs: [{
        type: 'lendingRepay',
        data: { borrowerEntityId, loanId, ...(amount !== undefined && amount !== null ? { amount } : {}) },
      }],
    }],
  });
  return new Response(safeStringify({ success: true, hubEntityId: hub.hubEntityId, borrowerEntityId, loanId }), { headers });
};
