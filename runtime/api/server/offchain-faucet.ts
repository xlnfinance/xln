import { ethers } from 'ethers';
import type { EntityTx } from '../../types/entity-tx';
import type { RuntimeReplica, RuntimeInput } from '../../runtime/types';
import { safeStringify } from '../../protocol/serialization';
import type { Profile } from '../../entity/profile';
import { normalizeRuntimeKey, pushDebugEvent, type RelayStore } from '../../network/relay/store';
import { createStructuredLogger, shortId } from '../../infra/logger';
import { encodeRebalancePolicyMemo } from '../../extensions/rebalance/policy';
import { resolveEntityProposerId } from '../../runtime/entity-output-signer';
import { getErrorMessage, isEntityId32 } from './utils';
import { getAccountReplica, getEntityOutCapacity, getEntityReplicaById, hasAccount } from './entity-lookup';
import { withRuntimeCommittedRead } from '../../runtime/frame/writer-lock';
import { getFaucetHubProfiles } from './faucet-hubs';
import type { RegisterReceiptOptions, RuntimeIngressReceipt } from '../../runtime/ingress-receipts';
import {
  describeOffchainFaucetAccountState,
  shouldRejectOffchainFaucetForSettledCapacity,
} from './offchain-faucet-admission';
import { faucetFailureBody } from './faucet-failure';
import { getTokenInfo } from '../../account/utils';
import { getDefaultRebalanceBaseFeeForToken } from '../../account/rebalance-defaults';

const faucetLog = createStructuredLogger('server.faucet');

type OffchainFaucetHandlerInput = {
  req: Request;
  env: RuntimeReplica | null;
  headers: HeadersInit;
  relayStore: RelayStore;
  enqueueRuntimeInput: (env: RuntimeReplica, runtimeInput: RuntimeInput) => void;
  validateRuntimeInputAdmission: (env: RuntimeReplica, runtimeInput: RuntimeInput) => void;
  registerReceipt: (receipt: RegisterReceiptOptions) => RuntimeIngressReceipt;
  getCurrentRuntimeHeight: (env: RuntimeReplica | null) => number;
  buildRuntimeInputStatusUrl: (id: string) => string;
};

type FaucetRequest = {
  requestId: string;
  userEntityId: string;
  userRuntimeId: string;
  requestedHubId: string;
  tokenId: number;
  amount: string;
};

type FaucetHub = {
  entityId: string;
  signerId: string;
};

type FaucetAccountAdmission = {
  accountState: ReturnType<typeof describeOffchainFaucetAccountState>;
  amountWei: bigint;
  currentOutCapacity: bigint;
};

type FaucetFailure = { ok: false; response: Response };
type FaucetPhase<T> = { ok: true; value: T } | FaucetFailure;

const fail = (
  headers: HeadersInit,
  status: number,
  body: Parameters<typeof faucetFailureBody>[0],
): FaucetFailure => ({
  ok: false,
  response: new Response(safeStringify(faucetFailureBody(body)), { status, headers }),
});

const resolveUserRuntimeId = (
  env: RuntimeReplica,
  userEntityId: string,
  runtimeId: unknown,
): string => {
  const explicit = normalizeRuntimeKey(runtimeId);
  if (explicit) return explicit;
  const profile = (env.gossip?.getProfiles() || []).find(
    (candidate: Profile) => String(candidate?.entityId || '').toLowerCase() === userEntityId,
  );
  return normalizeRuntimeKey(profile?.runtimeId);
};

const parseFaucetRequest = async (
  input: OffchainFaucetHandlerInput & { env: RuntimeReplica },
): Promise<FaucetPhase<FaucetRequest>> => {
  const body = await input.req.json() as Record<string, unknown>;
  const userEntityId = body['userEntityId'];
  const requestedHubEntityId = body['hubEntityId'];
  if (!userEntityId) {
    return fail(input.headers, 400, {
      code: 'FAUCET_USER_ENTITY_ID_REQUIRED',
      error: 'Missing userEntityId',
    });
  }
  if (!isEntityId32(userEntityId)) {
    return fail(input.headers, 400, {
      error: `Invalid userEntityId: expected bytes32 hex, got "${String(userEntityId)}"`,
      code: 'FAUCET_INVALID_USER_ENTITY_ID',
    });
  }
  if (requestedHubEntityId && !isEntityId32(requestedHubEntityId)) {
    return fail(input.headers, 400, {
      error: `Invalid hubEntityId: expected bytes32 hex, got "${String(requestedHubEntityId)}"`,
      code: 'FAUCET_INVALID_HUB_ENTITY_ID',
    });
  }
  const tokenId = Number(body['tokenId'] ?? 1);
  if (!Number.isSafeInteger(tokenId) || tokenId <= 0) {
    return fail(input.headers, 400, {
      error: `Invalid tokenId: expected positive safe integer, got "${String(body['tokenId'])}"`,
      code: 'FAUCET_INVALID_TOKEN_ID',
    });
  }
  const normalizedUserEntityId = String(userEntityId).toLowerCase();
  const normalizedUserRuntimeId = resolveUserRuntimeId(input.env, normalizedUserEntityId, body['userRuntimeId']);
  if (!normalizedUserRuntimeId) {
    return fail(input.headers, 400, {
      success: false,
      code: 'FAUCET_RUNTIME_REQUIRED',
      error: 'Missing userRuntimeId',
      extra: { message: 'Runtime is offline or not initialized yet. Re-open runtime and retry faucet.' },
    });
  }
  return {
    ok: true,
    value: {
      requestId: `offchain_${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`}`,
      userEntityId: normalizedUserEntityId,
      userRuntimeId: normalizedUserRuntimeId,
      requestedHubId: typeof requestedHubEntityId === 'string' ? requestedHubEntityId.toLowerCase() : '',
      tokenId,
      amount: String(body['amount'] ?? '100'),
    },
  };
};

const recordRuntimeVisibility = (
  relayStore: RelayStore,
  request: FaucetRequest,
): void => {
  const runtimeKey = normalizeRuntimeKey(request.userRuntimeId);
  const runtimeSeenLocally = relayStore.clients.has(runtimeKey);
  const runtimePubKey = relayStore.runtimeEncryptionKeys.get(runtimeKey);
  if (runtimeSeenLocally && runtimePubKey) return;
  faucetLog.info('offchain.runtime_not_local', {
    requestId: request.requestId,
    runtime: shortId(request.userRuntimeId, 10),
  });
  // The API may use an external relay, so local socket visibility is
  // diagnostic evidence only and must never reject a valid faucet request.
  pushDebugEvent(relayStore, {
    event: 'debug_event',
    status: 'info',
    reason: !runtimeSeenLocally ? 'FAUCET_RUNTIME_NOT_LOCAL_RELAY_CLIENT' : 'FAUCET_RUNTIME_PUBKEY_MISSING_LOCAL',
    details: {
      endpoint: '/api/faucet/offchain',
      userEntityId: request.userEntityId,
      userRuntimeId: request.userRuntimeId,
      runtimeSeenLocally,
      hasRuntimePubKey: Boolean(runtimePubKey),
      activeRelayClients: Array.from(relayStore.clients.keys()),
    },
  });
};

const resolveFaucetHub = (
  input: OffchainFaucetHandlerInput & { env: RuntimeReplica },
  request: FaucetRequest,
): FaucetPhase<FaucetHub> => {
  const activeHubs = input.relayStore.activeHubEntityIds.filter(Boolean).map(entityId => ({ entityId }));
  const gossipHubs = activeHubs.length > 0 ? [] : getFaucetHubProfiles(input.env, input.relayStore.activeHubEntityIds);
  const hubs = activeHubs.length > 0 ? activeHubs : gossipHubs;
  if (hubs.length === 0) {
    const profileCount = input.env.gossip?.getProfiles()?.length || 0;
    pushDebugEvent(input.relayStore, {
      event: 'error',
      status: 'rejected',
      reason: 'FAUCET_HUBS_EMPTY',
      details: {
        endpoint: '/api/faucet/offchain',
        profiles: profileCount,
        activeHubEntityIds: input.relayStore.activeHubEntityIds,
        gossipHubCount: gossipHubs.length,
        hint: 'No faucet-capable hubs in server active set or gossip cache',
      },
    });
    return fail(input.headers, 503, {
      error: 'No faucet hub available in gossip',
      code: 'FAUCET_HUBS_EMPTY',
      extra: {
        profiles: profileCount,
        activeHubEntityIds: input.relayStore.activeHubEntityIds,
        gossipHubCount: gossipHubs.length,
      },
    });
  }
  if (!request.requestedHubId) {
    return fail(input.headers, 400, {
      error: 'Missing hubEntityId for offchain faucet',
      code: 'FAUCET_HUB_REQUIRED',
      extra: { knownHubEntityIds: hubs.map(hub => hub.entityId) },
    });
  }
  const selected = hubs.find(hub => hub.entityId.toLowerCase() === request.requestedHubId);
  if (!selected) {
    return fail(input.headers, 404, {
      error: `Requested hub not found: ${request.requestedHubId}`,
      code: 'FAUCET_REQUESTED_HUB_NOT_FOUND',
      extra: {
        requestedHubEntityId: request.requestedHubId,
        knownHubEntityIds: hubs.map(hub => hub.entityId),
      },
    });
  }
  if (!getEntityReplicaById(input.env, selected.entityId)) {
    return fail(input.headers, 503, {
      error: 'Faucet hub is not ready yet',
      code: 'FAUCET_HUB_NOT_READY',
      extra: { hubEntityId: selected.entityId },
    });
  }
  try {
    return {
      ok: true,
      value: {
        entityId: selected.entityId,
        signerId: resolveEntityProposerId(input.env, selected.entityId, 'faucet-offchain'),
      },
    };
  } catch (error) {
    return fail(input.headers, 503, {
      error: 'Faucet hub signer is unavailable',
      code: 'FAUCET_HUB_SIGNER_UNAVAILABLE',
      extra: { hubEntityId: selected.entityId, details: getErrorMessage(error) },
    });
  }
};

const admitFaucetAccount = (
  input: OffchainFaucetHandlerInput & { env: RuntimeReplica },
  request: FaucetRequest,
  hub: FaucetHub,
): FaucetPhase<FaucetAccountAdmission> => {
  const account = getAccountReplica(input.env, hub.entityId, request.userEntityId);
  const knownHubIds = input.relayStore.activeHubEntityIds;
  const accountPresence = knownHubIds.map(hubEntityId => ({
    hubEntityId,
    hasAccount: hasAccount(input.env, hubEntityId, request.userEntityId),
  }));
  // Faucet is an enqueue endpoint, not a settlement oracle. It never repairs
  // bilateral state or waits for the peer replica inside the HTTP request.
  if (!account && !hasAccount(input.env, hub.entityId, request.userEntityId)) {
    pushDebugEvent(input.relayStore, {
      event: 'error',
      status: 'rejected',
      reason: 'FAUCET_ACCOUNT_NOT_OPEN',
      details: {
        requestId: request.requestId,
        hubEntityId: hub.entityId,
        userEntityId: request.userEntityId,
        requestedHubEntityId: request.requestedHubId,
        accountPresence,
      },
    });
    return fail(input.headers, 409, {
      success: false,
      error: 'No bilateral account with selected hub. Open account first, then retry faucet.',
      code: 'FAUCET_ACCOUNT_NOT_OPEN',
      extra: {
        requestId: request.requestId,
        hubEntityId: hub.entityId,
        userEntityId: request.userEntityId,
        requestedHubEntityId: request.requestedHubId,
        accountPresence,
      },
    });
  }
  const accountState = describeOffchainFaucetAccountState(account);
  if (!accountState.settledCapacitySnapshot) {
    pushDebugEvent(input.relayStore, {
      event: 'debug_event',
      status: 'queued',
      reason: 'FAUCET_ACCOUNT_HAS_PENDING_SETUP',
      details: {
        requestId: request.requestId,
        hubEntityId: hub.entityId,
        userEntityId: request.userEntityId,
        requestedHubEntityId: request.requestedHubId,
        accountState,
      },
    });
  }
  const amountWei = ethers.parseUnits(request.amount, getTokenInfo(request.tokenId).decimals);
  const currentOutCapacity = getEntityOutCapacity(account?.state ?? null, hub.entityId, request.tokenId);
  if (shouldRejectOffchainFaucetForSettledCapacity({
    account,
    senderOutCapacity: currentOutCapacity,
    amount: amountWei,
  })) {
    return fail(input.headers, 409, {
      success: false,
      error: 'Selected hub does not have enough outbound capacity for offchain faucet.',
      code: 'FAUCET_INSUFFICIENT_OUT_CAPACITY',
      extra: {
        requestId: request.requestId,
        hubEntityId: hub.entityId,
        userEntityId: request.userEntityId,
        tokenId: request.tokenId,
        requiredAmount: amountWei.toString(),
        senderOutCapacity: currentOutCapacity.toString(),
        accountState,
      },
    });
  }
  return { ok: true, value: { accountState, amountWei, currentOutCapacity } };
};

const buildFaucetRuntimeInput = (
  env: RuntimeReplica,
  request: FaucetRequest,
  hub: FaucetHub,
  amountWei: bigint,
): RuntimeInput => {
  const policy = getEntityReplicaById(env, hub.entityId)?.state?.hubRebalanceConfig;
  const description = encodeRebalancePolicyMemo('faucet-offchain', {
    policyVersion:
      Number.isFinite(Number(policy?.policyVersion)) && Number(policy?.policyVersion) > 0
        ? Number(policy?.policyVersion)
        : 1,
    baseFee: getDefaultRebalanceBaseFeeForToken(request.tokenId),
    liquidityFeeBps: policy?.rebalanceLiquidityFeeBps ?? policy?.minFeeBps ?? 1n,
    gasFee: 0n,
  });
  const entityTxs: EntityTx[] = [{
    type: 'directPayment',
    data: {
      targetEntityId: request.userEntityId,
      tokenId: request.tokenId,
      amount: amountWei,
      route: [hub.entityId, request.userEntityId],
      deliveryMode: 'direct',
      description,
    },
  }];
  return {
    runtimeTxs: [],
    entityInputs: [{ entityId: hub.entityId, signerId: hub.signerId, entityTxs }],
  };
};

const enqueueFaucetPayment = (
  input: OffchainFaucetHandlerInput & { env: RuntimeReplica },
  request: FaucetRequest,
  runtimeInput: RuntimeInput,
): FaucetPhase<RuntimeIngressReceipt> => {
  try {
    input.validateRuntimeInputAdmission(input.env, runtimeInput);
    input.enqueueRuntimeInput(input.env, runtimeInput);
    return {
      ok: true,
      value: input.registerReceipt({
        id: request.requestId,
        kind: 'faucet-offchain',
        counts: { runtimeTxs: 0, entityInputs: 1, jInputs: 0 },
        enqueuedHeight: input.getCurrentRuntimeHeight(input.env),
        runtimeInput,
        note: 'Faucet payment was accepted into the runtime queue; poll statusUrl and account state for settlement.',
      }),
    };
  } catch (error) {
    return fail(input.headers, 503, {
      error: 'Failed to admit faucet payment into runtime',
      code: 'FAUCET_PAYMENT_ADMISSION_FAILED',
      extra: { details: getErrorMessage(error) },
    });
  }
};

const successResponse = (
  input: OffchainFaucetHandlerInput,
  request: FaucetRequest,
  hub: FaucetHub,
  admission: FaucetAccountAdmission,
  receipt: RuntimeIngressReceipt,
  requestStartedAt: number,
): Response => {
  const serverDurationMs = Date.now() - requestStartedAt;
  faucetLog.info('offchain.accepted', { requestId: request.requestId, durationMs: serverDurationMs });
  return new Response(JSON.stringify({
    success: true,
    type: 'offchain',
    status: 'queued',
    requestId: request.requestId,
    receipt,
    statusUrl: input.buildRuntimeInputStatusUrl(request.requestId),
    amount: request.amount,
    tokenId: request.tokenId,
    from: `${hub.entityId.slice(0, 16)}...`,
    to: `${request.userEntityId.slice(0, 16)}...`,
    accountReady: admission.accountState.settledCapacitySnapshot,
    accountState: admission.accountState,
    senderOutCapacity: admission.currentOutCapacity.toString(),
    serverDurationMs,
  }), { headers: input.headers });
};

export const handleOffchainFaucet = async (
  input: OffchainFaucetHandlerInput,
): Promise<Response> => {
  const requestStartedAt = Date.now();
  try {
    if (!input.env) {
      return fail(input.headers, 503, {
        code: 'FAUCET_RUNTIME_NOT_INITIALIZED',
        error: 'Runtime not initialized',
      }).response;
    }
    const initializedInput = { ...input, env: input.env };
    const parsed = await parseFaucetRequest(initializedInput);
    if (!parsed.ok) return parsed.response;
    const request = parsed.value;
    faucetLog.info('offchain.request', {
      requestId: request.requestId,
      user: shortId(request.userEntityId, 8),
      runtime: shortId(request.userRuntimeId, 10),
    });
    recordRuntimeVisibility(input.relayStore, request);
    return await withRuntimeCommittedRead(initializedInput.env, () => {
      const hub = resolveFaucetHub(initializedInput, request);
      if (!hub.ok) return hub.response;
      pushDebugEvent(input.relayStore, {
        event: 'debug_event',
        status: 'info',
        reason: 'REB_STEP0_FAUCET_REQUEST',
        details: { ...request, hubEntityId: hub.value.entityId },
      });
      const account = admitFaucetAccount(initializedInput, request, hub.value);
      if (!account.ok) return account.response;
      const runtimeInput = buildFaucetRuntimeInput(
        initializedInput.env,
        request,
        hub.value,
        account.value.amountWei,
      );
      const receipt = enqueueFaucetPayment(
        initializedInput,
        request,
        runtimeInput,
      );
      if (!receipt.ok) return receipt.response;
      return successResponse(
        input,
        request,
        hub.value,
        account.value,
        receipt.value,
        requestStartedAt,
      );
    });
  } catch (error: unknown) {
    const message = getErrorMessage(error, 'Unknown faucet error');
    faucetLog.error('offchain.error', { error: message });
    const unavailable =
      message.includes('SIGNER_RESOLUTION_FAILED') || message.includes('RUNTIME_REPLICA_NOT_FOUND');
    return fail(input.headers, unavailable ? 503 : 500, {
      code: unavailable ? 'FAUCET_RUNTIME_UNAVAILABLE' : 'FAUCET_UNHANDLED_ERROR',
      error: message,
    }).response;
  }
};
