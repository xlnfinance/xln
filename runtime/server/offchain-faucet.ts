import { ethers } from 'ethers';
import type { EntityTx, Env, RuntimeInput } from '../types';
import { safeStringify } from '../serialization-utils';
import type { Profile } from '../networking/gossip';
import { normalizeRuntimeKey, pushDebugEvent, type RelayStore } from '../relay-store';
import { createStructuredLogger, shortId } from '../logger';
import { encodeRebalancePolicyMemo } from '../rebalance-policy';
import { resolveEntityProposerId } from '../state-helpers';
import { getErrorMessage, isEntityId32 } from '../server-utils';
import { getAccountMachine, getEntityOutCapacity, getEntityReplicaById, hasAccount } from './entity-lookup';
import { getFaucetHubProfiles } from './faucet-hubs';
import type { RegisterReceiptOptions, RuntimeIngressReceipt } from './ingress-receipts';

const faucetLog = createStructuredLogger('server.faucet');

const isAccountConsensusReadyForFaucet = (account: ReturnType<typeof getAccountMachine>): boolean => {
  if (!account) return false;
  if (!account.currentFrame) return false;
  if (Number(account.currentHeight ?? 0) <= 0) return false;
  if (account.pendingFrame) return false;
  if ((account.mempool?.length ?? 0) > 0) return false;
  return true;
};

const describeAccountConsensusState = (account: ReturnType<typeof getAccountMachine>) => ({
  exists: !!account,
  currentHeight: Number(account?.currentHeight ?? 0),
  pendingFrameHeight: account?.pendingFrame ? Number(account.pendingFrame.height ?? 0) : null,
  mempool: Number(account?.mempool?.length ?? 0),
});

export const handleOffchainFaucet = async (input: {
  req: Request;
  env: Env | null;
  headers: HeadersInit;
  relayStore: RelayStore;
  enqueueRuntimeInput: (env: Env, runtimeInput: RuntimeInput) => void;
  validateRuntimeInputAdmission: (env: Env, runtimeInput: RuntimeInput) => void;
  registerReceipt: (receipt: RegisterReceiptOptions) => RuntimeIngressReceipt;
  getCurrentRuntimeHeight: (env: Env | null) => number;
  buildRuntimeInputStatusUrl: (id: string) => string;
}): Promise<Response> => {
  const {
    req,
    env,
    headers,
    relayStore,
    enqueueRuntimeInput,
    validateRuntimeInputAdmission,
    registerReceipt,
    getCurrentRuntimeHeight,
    buildRuntimeInputStatusUrl,
  } = input;

    const requestStartedAt = Date.now();
    try {
      if (!env) {
        return new Response(safeStringify({ error: 'Runtime not initialized' }), { status: 503, headers });
      }

      const body = await req.json();
      const {
        userEntityId,
        userRuntimeId,
        tokenId = 1,
        amount = '100',
        hubEntityId: requestedHubEntityId,
      } = body;
      const requestId = `offchain_${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`}`;

      if (!userEntityId) {
        return new Response(safeStringify({ error: 'Missing userEntityId' }), { status: 400, headers });
      }
      if (!isEntityId32(userEntityId)) {
        return new Response(
          JSON.stringify({
            error: `Invalid userEntityId: expected bytes32 hex, got "${String(userEntityId)}"`,
            code: 'FAUCET_INVALID_USER_ENTITY_ID',
          }),
          { status: 400, headers },
        );
      }
      if (
        requestedHubEntityId !== undefined &&
        requestedHubEntityId !== null &&
        requestedHubEntityId !== '' &&
        !isEntityId32(requestedHubEntityId)
      ) {
        return new Response(
          JSON.stringify({
            error: `Invalid hubEntityId: expected bytes32 hex, got "${String(requestedHubEntityId)}"`,
            code: 'FAUCET_INVALID_HUB_ENTITY_ID',
          }),
          { status: 400, headers },
        );
      }
      const normalizedUserEntityId = String(userEntityId).toLowerCase();
      let normalizedUserRuntimeId = normalizeRuntimeKey(userRuntimeId);
      if (!normalizedUserRuntimeId) {
        const allProfiles = env.gossip?.getProfiles() || [];
        const userProfile = allProfiles.find(
          (p: Profile) => String(p?.entityId || '').toLowerCase() === normalizedUserEntityId,
        );
        const profileRuntimeId = normalizeRuntimeKey(userProfile?.runtimeId);
        if (profileRuntimeId) {
          normalizedUserRuntimeId = profileRuntimeId;
        }
      }
      if (!normalizedUserRuntimeId) {
        return new Response(
          JSON.stringify({
            success: false,
            code: 'FAUCET_RUNTIME_REQUIRED',
            error: 'Missing userRuntimeId',
            message: 'Runtime is offline or not initialized yet. Re-open runtime and retry faucet.',
          }),
          { status: 400, headers },
        );
      }
      const normalizedRuntimeKey = normalizeRuntimeKey(normalizedUserRuntimeId);
      faucetLog.info('offchain.request', {
        requestId,
        user: shortId(normalizedUserEntityId, 8),
        runtime: shortId(normalizedUserRuntimeId, 10),
      });
      // Important: local relay client registry is authoritative only when faucet API
      // and relay endpoint are the same node. With external relay (e.g. wss://xln.finance/relay),
      // this process may not see the runtime socket directly. Treat local visibility as diagnostic,
      // not a hard reject.
      const runtimeSeenLocally = relayStore.clients.has(normalizedRuntimeKey);
      const runtimePubKey = relayStore.runtimeEncryptionKeys.get(normalizedRuntimeKey);
      if (!runtimeSeenLocally || !runtimePubKey) {
        const activeRelayClients = Array.from(relayStore.clients.keys());
        faucetLog.warn('offchain.runtime_local_miss', { requestId, runtime: shortId(normalizedUserRuntimeId, 10) });
        pushDebugEvent(relayStore, {
          event: 'debug_event',
          status: 'warning',
          reason: !runtimeSeenLocally ? 'FAUCET_RUNTIME_NOT_LOCAL_RELAY_CLIENT' : 'FAUCET_RUNTIME_PUBKEY_MISSING_LOCAL',
          details: {
            endpoint: '/api/faucet/offchain',
            userEntityId: normalizedUserEntityId,
            userRuntimeId: normalizedUserRuntimeId,
            runtimeSeenLocally,
            hasRuntimePubKey: !!runtimePubKey,
            activeRelayClients,
          },
        });
      }
      // Get hub from server-authoritative hub set + gossip
      const activeHubCandidates = relayStore.activeHubEntityIds
        .map(entityId => ({ entityId }))
        .filter(hub => !!hub.entityId);
      // Server authority first: if hubs are active on this server, faucet can always target them
      // without depending on client gossip freshness.
      const gossipHubs = activeHubCandidates.length > 0 ? [] : getFaucetHubProfiles(env, relayStore.activeHubEntityIds);
      const hubs = activeHubCandidates.length > 0 ? activeHubCandidates : gossipHubs;
      if (hubs.length === 0) {
        const allProfiles = env.gossip?.getProfiles() || [];
        pushDebugEvent(relayStore, {
          event: 'error',
          status: 'rejected',
          reason: 'FAUCET_HUBS_EMPTY',
          details: {
            endpoint: '/api/faucet/offchain',
            profiles: allProfiles.length,
            activeHubEntityIds: relayStore.activeHubEntityIds,
            gossipHubCount: gossipHubs.length,
            hint: 'No faucet-capable hubs in server active set or gossip cache',
          },
        });
        return new Response(
          JSON.stringify({
            error: 'No faucet hub available in gossip',
            code: 'FAUCET_HUBS_EMPTY',
            profiles: allProfiles.length,
            activeHubEntityIds: relayStore.activeHubEntityIds,
            gossipHubCount: gossipHubs.length,
          }),
          { status: 503, headers },
        );
      }
      const requestedHubId =
        typeof requestedHubEntityId === 'string' && requestedHubEntityId.length > 0
          ? requestedHubEntityId.toLowerCase()
          : '';
      if (!requestedHubId) {
        return new Response(
          JSON.stringify({
            error: 'Missing hubEntityId for offchain faucet',
            code: 'FAUCET_HUB_REQUIRED',
            knownHubEntityIds: hubs.map(hub => hub.entityId),
          }),
          { status: 400, headers },
        );
      }
      const requestedHub = hubs.find(hub => hub.entityId.toLowerCase() === requestedHubId);
      if (!requestedHub) {
        return new Response(
          JSON.stringify({
            error: `Requested hub not found: ${requestedHubId}`,
            code: 'FAUCET_REQUESTED_HUB_NOT_FOUND',
            requestedHubEntityId: requestedHubId,
            knownHubEntityIds: hubs.map(h => h.entityId),
          }),
          { status: 404, headers },
        );
      }
      const hubEntityId = requestedHub.entityId;
      if (!getEntityReplicaById(env, hubEntityId)) {
        return new Response(
          JSON.stringify({
            error: 'Faucet hub is not ready yet',
            code: 'FAUCET_HUB_NOT_READY',
            hubEntityId,
          }),
          { status: 503, headers },
        );
      }
      // Get actual signerId from entity's validators (not runtimeId!)
      let hubSignerId: string;
      try {
        hubSignerId = resolveEntityProposerId(env, hubEntityId, 'faucet-offchain');
      } catch (error) {
        return new Response(
          JSON.stringify({
            error: 'Faucet hub signer is unavailable',
            code: 'FAUCET_HUB_SIGNER_UNAVAILABLE',
            hubEntityId,
            details: (error as Error).message,
          }),
          { status: 503, headers },
        );
      }
      pushDebugEvent(relayStore, {
        event: 'debug_event',
        status: 'info',
        reason: 'REB_STEP0_FAUCET_REQUEST',
        details: {
          requestId,
          hubEntityId,
          userEntityId: normalizedUserEntityId,
          userRuntimeId: normalizedUserRuntimeId,
          tokenId,
          amount,
        },
      });

      const amountWei = ethers.parseUnits(amount, 18);
      const accountMachine = getAccountMachine(env, hubEntityId, normalizedUserEntityId);
      const hasHubAccount = hasAccount(env, hubEntityId, normalizedUserEntityId) || !!accountMachine;
      const buildAccountPresence = () => hubs.map(hub => ({
        hubEntityId: hub.entityId,
        hasAccount: hasAccount(env, hub.entityId, normalizedUserEntityId),
      }));

      // Explicit invariant:
      // faucet is a one-way enqueue endpoint, not a synchronous settlement oracle.
      // It never tries to "repair" credit/sync state and never waits for the
      // counterparty side to materialize locally inside serverEnv.
      if (!hasHubAccount) {
        pushDebugEvent(relayStore, {
          event: 'error',
          status: 'rejected',
          reason: 'FAUCET_ACCOUNT_NOT_OPEN',
          details: {
            requestId,
            hubEntityId,
            userEntityId: normalizedUserEntityId,
            requestedHubEntityId: requestedHubId || null,
            accountPresence: buildAccountPresence(),
          },
        });
        const accountPresence = buildAccountPresence();
        return new Response(
          JSON.stringify({
            success: false,
            error: 'No bilateral account with selected hub. Open account first, then retry faucet.',
            code: 'FAUCET_ACCOUNT_NOT_OPEN',
            requestId,
            hubEntityId,
            userEntityId: normalizedUserEntityId,
            requestedHubEntityId: requestedHubId || null,
            accountPresence,
          }),
          { status: 409, headers },
        );
      }
      if (!isAccountConsensusReadyForFaucet(accountMachine)) {
        const accountState = describeAccountConsensusState(accountMachine);
        pushDebugEvent(relayStore, {
          event: 'debug_event',
          status: 'rejected',
          reason: 'FAUCET_ACCOUNT_NOT_READY',
          details: {
            requestId,
            hubEntityId,
            userEntityId: normalizedUserEntityId,
            requestedHubEntityId: requestedHubId || null,
            accountState,
          },
        });
        return new Response(
          JSON.stringify({
            success: false,
            error: 'Selected hub account is still settling off-chain setup. Retry after the account frame commits.',
            code: 'FAUCET_ACCOUNT_NOT_READY',
            requestId,
            hubEntityId,
            userEntityId: normalizedUserEntityId,
            requestedHubEntityId: requestedHubId || null,
            accountState,
          }),
          { status: 409, headers },
        );
      }
      const currentOutCapacity = getEntityOutCapacity(accountMachine, hubEntityId, tokenId);
      if (currentOutCapacity < amountWei) {
        return new Response(
          JSON.stringify({
            success: false,
            error: 'Selected hub does not have enough outbound capacity for offchain faucet.',
            code: 'FAUCET_INSUFFICIENT_OUT_CAPACITY',
            requestId,
            hubEntityId,
            userEntityId: normalizedUserEntityId,
            tokenId,
            requiredAmount: amountWei.toString(),
            senderOutCapacity: currentOutCapacity.toString(),
          }),
          { status: 409, headers },
        );
      }

      // Single-writer invariant: enqueue only; runtime loop applies.
      let receipt: RuntimeIngressReceipt | null = null;
      try {
        const hubPolicy = getEntityReplicaById(env, hubEntityId)?.state?.hubRebalanceConfig;
        const faucetDescription = encodeRebalancePolicyMemo('faucet-offchain', {
          policyVersion:
            Number.isFinite(Number(hubPolicy?.policyVersion)) && Number(hubPolicy?.policyVersion) > 0
              ? Number(hubPolicy?.policyVersion)
              : 1,
          baseFee: hubPolicy?.rebalanceBaseFee ?? 10n ** 17n,
          liquidityFeeBps: hubPolicy?.rebalanceLiquidityFeeBps ?? hubPolicy?.minFeeBps ?? 1n,
          gasFee: hubPolicy?.rebalanceGasFee ?? 0n,
        });
        const entityTxs: EntityTx[] = [{
          type: 'directPayment',
          data: {
            targetEntityId: normalizedUserEntityId,
            tokenId,
            amount: amountWei,
            route: [hubEntityId, normalizedUserEntityId],
            description: faucetDescription,
          },
        }];
        const runtimeInput: RuntimeInput = {
          runtimeTxs: [],
          entityInputs: [
            {
              entityId: hubEntityId,
              signerId: hubSignerId,
              entityTxs,
            },
          ],
        };
        validateRuntimeInputAdmission(env, runtimeInput);
        enqueueRuntimeInput(env, runtimeInput);
        receipt = registerReceipt({
          id: requestId,
          kind: 'faucet-offchain',
          counts: { runtimeTxs: 0, entityInputs: 1, jInputs: 0 },
          enqueuedHeight: getCurrentRuntimeHeight(env),
          note: 'Faucet payment was accepted into the runtime queue; poll statusUrl and account state for settlement.',
        });
      } catch (error) {
        return new Response(
          JSON.stringify({
            error: 'Failed to admit faucet payment into runtime',
            code: 'FAUCET_PAYMENT_ADMISSION_FAILED',
            details: (error as Error).message,
          }),
          { status: 503, headers },
        );
      }
      if (!receipt) {
        return new Response(
          JSON.stringify({
            error: 'Failed to register faucet payment receipt',
            code: 'FAUCET_PAYMENT_RECEIPT_FAILED',
          }),
          { status: 503, headers },
        );
      }
      const serverDurationMs = Date.now() - requestStartedAt;
      faucetLog.info('offchain.accepted', { requestId, durationMs: serverDurationMs });

      return new Response(
        JSON.stringify({
          success: true,
          type: 'offchain',
          status: 'queued',
          requestId,
          receipt,
          statusUrl: buildRuntimeInputStatusUrl(requestId),
          amount,
          tokenId,
          from: hubEntityId.slice(0, 16) + '...',
          to: normalizedUserEntityId.slice(0, 16) + '...',
          accountReady: true,
          senderOutCapacity: currentOutCapacity.toString(),
          serverDurationMs,
        }),
        { headers },
      );
    } catch (error: unknown) {
      faucetLog.error('offchain.error', { error: getErrorMessage(error) });
      const message = getErrorMessage(error, 'Unknown faucet error');
      const status =
        message.includes('SIGNER_RESOLUTION_FAILED') || message.includes('RUNTIME_REPLICA_NOT_FOUND') ? 503 : 500;
      return new Response(safeStringify({ error: message }), { status, headers });
    }
  
};
