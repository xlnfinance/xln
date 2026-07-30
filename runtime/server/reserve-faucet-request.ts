import type { EntityTx } from '../types/entity-tx';
import type { RuntimeInput, RuntimeReplica } from '../runtime/types';
import type { JAdapter } from '../jadapter';
import { safeStringify } from '../protocol/serialization';
import { createStructuredLogger, shortId } from '../infra/logger';
import { resolveEntityProposerId } from '../runtime/entity-output-signer';
import { formatTimingMs, isEntityId32 } from './utils';
import { faucetFailureBody } from './faucet-failure';
import { getFaucetHubProfiles } from './faucet-hubs';
import {
  parseReserveFaucetAmount,
  waitForReserveUpdatedEvidence,
  type TokenCatalogEntry,
} from './reserve-faucet-evidence';
import {
  waitForEntityBroadcastWindow,
  waitForJBatchClear,
  waitForReserveUpdate,
  waitForRuntimeIdle,
} from './reserve-faucet-waits';
import { withRuntimeCommittedRead } from '../runtime/frame/writer-lock';

const faucetLog = createStructuredLogger('server.faucet');

export type ReserveFaucetDependencies = {
  req: Request;
  env: RuntimeReplica;
  adapter: JAdapter;
  headers: HeadersInit;
  activeHubEntityIds: string[];
  ensureTokenCatalog: () => Promise<TokenCatalogEntry[]>;
  validateRuntimeInputAdmission: (env: RuntimeReplica, runtimeInput: RuntimeInput) => void;
  enqueueRuntimeInput: (env: RuntimeReplica, runtimeInput: RuntimeInput) => void;
};

type ReserveRequest = {
  userEntityId: string;
  tokenId: number;
  tokenSymbol: string | undefined;
  amount: string;
  requestId: string;
};

type AdmittedReserveRequest = ReserveRequest & {
  amountWei: bigint;
  hubEntityId: string;
  hubSignerId: string;
  previousUserReserve: bigint;
  startedAt: number;
};

const failure = (
  headers: HeadersInit,
  status: number,
  code: string,
  error: string,
  extra?: Record<string, unknown>,
): Response => new Response(
  safeStringify(faucetFailureBody({
    code,
    error,
    ...(extra ? { extra } : {}),
  })),
  { status, headers },
);

const parseRequest = async (req: Request, headers: HeadersInit): Promise<ReserveRequest | Response> => {
  const body: unknown = await req.json();
  if (!body || typeof body !== 'object') {
    return failure(headers, 400, 'FAUCET_USER_ENTITY_ID_REQUIRED', 'Missing userEntityId');
  }
  const value = body as Record<string, unknown>;
  if (!isEntityId32(value['userEntityId'])) {
    return failure(headers, 400, 'FAUCET_USER_ENTITY_ID_INVALID', 'Invalid userEntityId');
  }
  const rawTokenId = value['tokenId'] ?? 1;
  const tokenId = typeof rawTokenId === 'number' ? rawTokenId : Number(rawTokenId);
  if (!Number.isSafeInteger(tokenId) || tokenId < 0) {
    return failure(headers, 400, 'FAUCET_INVALID_TOKEN_ID', 'Invalid tokenId');
  }
  return {
    userEntityId: value['userEntityId'],
    tokenId,
    tokenSymbol: typeof value['tokenSymbol'] === 'string' ? value['tokenSymbol'] : undefined,
    amount: typeof value['amount'] === 'string' ? value['amount'] : String(value['amount'] ?? '100'),
    requestId: globalThis.crypto.randomUUID(),
  };
};

const resolveToken = (
  request: ReserveRequest,
  catalog: TokenCatalogEntry[],
  headers: HeadersInit,
): { tokenId: number; amountWei: bigint } | Response => {
  const byId = catalog.find(token => Number(token.tokenId) === request.tokenId);
  const bySymbol = request.tokenSymbol
    ? catalog.find(token => token.symbol?.toUpperCase() === request.tokenSymbol?.toUpperCase())
    : undefined;
  const token = byId ?? bySymbol;
  const tokenId = Number(token?.tokenId);
  if (!token || !Number.isSafeInteger(tokenId) || tokenId < 0) {
    return failure(headers, 400, 'FAUCET_TOKEN_UNKNOWN', 'Unknown token for faucet', {
      tokenId: request.tokenId,
      tokenSymbol: request.tokenSymbol,
    });
  }
  return { tokenId, amountWei: parseReserveFaucetAmount(request.amount, token) };
};

const admitRequest = async (
  deps: ReserveFaucetDependencies,
  request: ReserveRequest,
): Promise<AdmittedReserveRequest | Response> => {
  const token = resolveToken(request, await deps.ensureTokenCatalog(), deps.headers);
  if (token instanceof Response) return token;
  const localAdmission = await withRuntimeCommittedRead(deps.env, () => {
    const hubs = getFaucetHubProfiles(deps.env, deps.activeHubEntityIds);
    if (hubs.length === 0) {
      return failure(
        deps.headers,
        503,
        'FAUCET_HUBS_EMPTY',
        'No faucet hub available',
        {
          profiles: deps.env.gossip?.getProfiles?.()?.length || 0,
          activeHubEntityIds: deps.activeHubEntityIds,
        },
      );
    }
    const hubEntityId = hubs[0]!.entityId;
    const hubSignerId = resolveEntityProposerId(
      deps.env,
      hubEntityId,
      'faucet-reserve',
    );
    const hubReplica = Array.from(deps.env.state.eReplicas.values())
      .find(replica => replica.entityId === hubEntityId);
    const hubReserve = hubReplica?.state.reserves.get(token.tokenId) ?? 0n;
    if (hubReserve < token.amountWei) {
      return failure(
        deps.headers,
        409,
        'FAUCET_HUB_INSUFFICIENT_RESERVES',
        `Hub has insufficient reserves for token ${token.tokenId}`,
        {
          have: hubReserve.toString(),
          need: token.amountWei.toString(),
          requestId: request.requestId,
        },
      );
    }
    return { hubEntityId, hubSignerId };
  });
  if (localAdmission instanceof Response) return localAdmission;
  const previousUserReserve = await deps.adapter.getReserves(
    request.userEntityId,
    token.tokenId,
  );
  return {
    ...request,
    ...token,
    ...localAdmission,
    previousUserReserve,
    startedAt: Date.now(),
  };
};

const entityInput = (
  request: AdmittedReserveRequest,
  entityTxs: EntityTx[],
): RuntimeInput => ({
  runtimeTxs: [],
  entityInputs: [{
    entityId: request.hubEntityId,
    signerId: request.hubSignerId,
    entityTxs,
  }],
});

const enqueueValidatedInput = (
  deps: ReserveFaucetDependencies,
  runtimeInput: RuntimeInput,
): void => {
  // HTTP is an untrusted source boundary. Admission must run before the input
  // reaches the one Runtime mempool; the frame reducer must not discover a
  // malformed faucet instruction after unrelated valid work was queued.
  deps.validateRuntimeInputAdmission(deps.env, runtimeInput);
  deps.enqueueRuntimeInput(deps.env, runtimeInput);
};

const dispatchReserveBatch = async (
  deps: ReserveFaucetDependencies,
  request: AdmittedReserveRequest,
): Promise<Response | null> => {
  enqueueValidatedInput(deps, entityInput(request, [{
    type: 'r2r',
    data: {
      toEntityId: request.userEntityId,
      tokenId: request.tokenId,
      amount: request.amountWei,
    },
  }]));
  if (!await waitForRuntimeIdle(deps.env, deps.adapter)) {
    faucetLog.warn('reserve.runtime_idle_timeout', { requestId: request.requestId });
  }
  if (!await waitForEntityBroadcastWindow(deps.env, deps.adapter, request.hubEntityId)) {
    return failure(deps.headers, 504, 'FAUCET_SENT_BATCH_TIMEOUT', 'Hub sentBatch did not clear in time', {
      requestId: request.requestId,
    });
  }
  enqueueValidatedInput(deps, entityInput(request, [{ type: 'j_broadcast', data: {} }]));
  if (!await waitForRuntimeIdle(deps.env, deps.adapter)) {
    faucetLog.warn('reserve.broadcast_idle_timeout', { requestId: request.requestId });
  }
  if (!await waitForJBatchClear(deps.env, deps.adapter)) {
    return failure(deps.headers, 504, 'FAUCET_J_BATCH_TIMEOUT', 'J-batch did not broadcast in time', {
      requestId: request.requestId,
    });
  }
  return null;
};

const confirmReserve = async (
  deps: ReserveFaucetDependencies,
  request: AdmittedReserveRequest,
): Promise<Response> => {
  const expectedMin = request.previousUserReserve + request.amountWei;
  const updated = await waitForReserveUpdate(
    deps.adapter,
    request.userEntityId,
    request.tokenId,
    expectedMin,
  );
  if (updated === null) {
    return failure(deps.headers, 504, 'FAUCET_RESERVE_UPDATE_TIMEOUT',
      'Reserve update not confirmed on-chain', { requestId: request.requestId });
  }
  const event = await waitForReserveUpdatedEvidence(
    deps.env,
    request.userEntityId,
    request.tokenId,
    expectedMin,
  );
  if (!event) {
    return failure(deps.headers, 500, 'FAUCET_RESERVE_EVENT_MISSING', 'RESERVE_EVENT_MISSING', {
      requestId: request.requestId,
      entityId: request.userEntityId,
      tokenId: request.tokenId,
      expectedMin: expectedMin.toString(),
      updatedReserve: updated.toString(),
    });
  }
  faucetLog.info('reserve.accepted', {
    requestId: request.requestId,
    totalMs: formatTimingMs(Date.now() - request.startedAt),
    updatedReserve: updated.toString(),
  });
  return new Response(safeStringify({
    success: true,
    type: 'reserve',
    amount: request.amount,
    tokenId: request.tokenId,
    from: `${request.hubEntityId.slice(0, 16)}...`,
    to: `${request.userEntityId.slice(0, 16)}...`,
    requestId: request.requestId,
    events: [event],
  }), { headers: deps.headers });
};

export const runReserveFaucetRequest = async (deps: ReserveFaucetDependencies): Promise<Response> => {
  const parsed = await parseRequest(deps.req, deps.headers);
  if (parsed instanceof Response) return parsed;
  const admitted = await admitRequest(deps, parsed);
  if (admitted instanceof Response) return admitted;
  faucetLog.info('reserve.request', {
    requestId: admitted.requestId,
    hub: shortId(admitted.hubEntityId, 8),
    user: shortId(admitted.userEntityId, 8),
    tokenId: admitted.tokenId,
    amount: admitted.amount,
  });
  const dispatchFailure = await dispatchReserveBatch(deps, admitted);
  return dispatchFailure ?? confirmReserve(deps, admitted);
};
