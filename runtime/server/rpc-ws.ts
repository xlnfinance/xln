import { ethers } from 'ethers';
import {
  ensureGossipProfiles,
  enqueueRuntimeInput,
  getPersistedLatestHeight,
  listPersistedCheckpointHeights,
  listPersistedEntityIdsAtHeight,
  loadEntityAccountDocFromStorageDb,
  loadEntityStateFromStorageDb,
  loadEntityViewPageFromStorageDb,
  readPersistedFrameJournals,
  readPersistedStorageFrameRecord,
  readPersistedStorageHead,
} from '../runtime.ts';
import { handleRuntimeAdapterMessage } from '../radapter/server';
import { isMarketMessageType } from '../relay/market-subscriptions';
import type { RelayStore } from '../relay-store';
import { safeStringify } from '../serialization-utils';
import { resolveEntityProposerId } from '../state-helpers';
import type { EntityTx, Env } from '../types';
import { hashHtlcSecret } from '../htlc-utils';
import { isEntityId32 } from '../server-utils';
import { requireDaemonRpcAuth } from './auth';
import { getEntityReplicaById } from './entity-lookup';
import type { RelaySocket } from './relay-direct';

type ServerRpcHandlerDeps = {
  getRelayStore: () => RelayStore;
};

type ReceiptLog = {
  message?: unknown;
  entityId?: unknown;
  data?: Record<string, unknown>;
};

const parseRpcBigInt = (value: unknown, field: string): bigint => {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'string' && /^-?\d+$/.test(value.trim())) return BigInt(value.trim());
  if (typeof value === 'number' && Number.isSafeInteger(value)) return BigInt(value);
  throw new Error(`${field} must be an integer string`);
};

const normalizeRpcStringArray = (value: unknown): string[] => {
  if (!Array.isArray(value)) return [];
  return value
    .map(item => (typeof item === 'string' ? item.trim() : ''))
    .filter(item => item.length > 0);
};

const filterReceiptLogs = (
  logs: ReceiptLog[],
  entityId?: string,
  eventNames?: string[],
): ReceiptLog[] => {
  const targetEntityId = typeof entityId === 'string' ? entityId.trim().toLowerCase() : '';
  const allowedEvents = new Set((eventNames || []).map(name => name.trim()).filter(Boolean));
  return logs.filter(log => {
    const eventName = typeof log?.message === 'string' ? log.message : '';
    if (allowedEvents.size > 0 && !allowedEvents.has(eventName)) return false;
    if (!targetEntityId) return true;
    const entityHint =
      typeof log?.entityId === 'string'
        ? log.entityId
        : typeof log?.data?.['entityId'] === 'string'
          ? log.data['entityId']
          : '';
    return entityHint.trim().toLowerCase() === targetEntityId;
  });
};

const resolveRpcPaymentRoute = async (
  env: Env,
  sourceEntityId: string,
  targetEntityId: string,
  tokenId: number,
  amount: bigint,
  routeOverride?: unknown,
): Promise<string[]> => {
  if (Array.isArray(routeOverride) && routeOverride.length >= 2) {
    const route = routeOverride
      .map(step => (typeof step === 'string' ? step.trim().toLowerCase() : ''))
      .filter(Boolean);
    if (route.length >= 2) return route;
  }

  try {
    await env.runtimeState?.p2p?.syncProfiles?.();
  } catch {
    // best effort prefetch only
  }

  try {
    await ensureGossipProfiles(env, [sourceEntityId, targetEntityId]);
  } catch {
    // best effort prefetch only
  }

  const routes = await env.gossip.getNetworkGraph().findPaths(sourceEntityId, targetEntityId, amount, tokenId);
  if (routes.length === 0) {
    try {
      await ensureGossipProfiles(env, [sourceEntityId, targetEntityId]);
    } catch {
      // best effort retry only
    }
  }
  const retryRoutes = routes.length > 0
    ? routes
    : await env.gossip.getNetworkGraph().findPaths(sourceEntityId, targetEntityId, amount, tokenId);
  if (retryRoutes.length === 0) {
    const profiles = env.gossip.getProfiles();
    const targetProfile = profiles.find(profile => profile.entityId.toLowerCase() === targetEntityId.toLowerCase()) || null;
    const hubCount = profiles.filter(profile => profile.metadata.isHub === true).length;
    throw new Error(
      `No route found from ${sourceEntityId} to ${targetEntityId} ` +
      `out of ${profiles.length} gossip profiles (hubs=${hubCount}, ` +
      `target lastUpdated=${targetProfile ? targetProfile.lastUpdated : 'missing'}, ` +
      `publicAccounts=${targetProfile ? targetProfile.publicAccounts.length : 0})`,
    );
  }
  return retryRoutes[0]!.path;
};

export const createServerRpcMessageHandler = ({ getRelayStore }: ServerRpcHandlerDeps) =>
  async (ws: RelaySocket, msg: Record<string, unknown>, env: Env | null): Promise<void> => {
    const handledByRuntimeAdapter = await handleRuntimeAdapterMessage(ws, msg, env, {
      enqueueRuntimeInput,
      readHead: targetEnv => readPersistedStorageHead(targetEnv),
      readFrame: (targetEnv, height) => readPersistedStorageFrameRecord(targetEnv, height),
      listCheckpoints: targetEnv => listPersistedCheckpointHeights(targetEnv),
      loadEntityState: (targetEnv, entityId, height) => loadEntityStateFromStorageDb(targetEnv, entityId, height),
      loadEntityAccountDoc: (targetEnv, entityId, counterpartyId, height) =>
        loadEntityAccountDocFromStorageDb(targetEnv, entityId, counterpartyId, height),
      loadEntityViewPage: (targetEnv, entityId, height, query) => loadEntityViewPageFromStorageDb(targetEnv, entityId, height, query),
      listEntityIdsAtHeight: (targetEnv, height) => listPersistedEntityIdsAtHeight(targetEnv, height),
    });
    if (handledByRuntimeAdapter) return;

    const relayStore = getRelayStore();
    const { type, id } = msg;

    if (isMarketMessageType(type)) {
      ws.send(safeStringify({ type: 'error', inReplyTo: id, error: 'market_* messages are supported on /relay websocket' }));
      return;
    }

    if (type === 'subscribe') {
      if (!requireDaemonRpcAuth(ws, id, msg, env, 'inspect')) return;
      const client = Array.from(relayStore.clients.values()).find(c => c.ws === ws);
      const topics = msg['topics'];
      if (client && Array.isArray(topics)) {
        for (const topic of topics) {
          client.topics.add(String(topic));
        }
      }
      ws.send(safeStringify({ type: 'ack', inReplyTo: id, status: 'subscribed' }));
      return;
    }

    if (type === 'get_env') {
      if (!requireDaemonRpcAuth(ws, id, msg, env, 'inspect')) return;
      if (!env) return;
      ws.send(
        safeStringify({
          type: 'env_snapshot',
          inReplyTo: id,
          data: {
            height: env.height,
            timestamp: env.timestamp,
            runtimeId: env.runtimeId,
            entityCount: env.eReplicas?.size || 0,
          },
        }),
      );
      return;
    }

    if (type === 'get_frame_receipts') {
      if (!requireDaemonRpcAuth(ws, id, msg, env, 'inspect')) return;
      if (!env) {
        ws.send(safeStringify({ type: 'error', inReplyTo: id, error: 'Runtime not ready' }));
        return;
      }
      try {
        const latestPersistedHeight = await getPersistedLatestHeight(env);
        const fromHeightRaw = Number(msg?.['fromHeight'] ?? msg?.['sinceHeight'] ?? 1);
        const toHeightRaw = Number(msg?.['toHeight'] ?? latestPersistedHeight);
        const limitRaw = Number(msg?.['limit'] ?? 200);
        const fromHeight = Number.isFinite(fromHeightRaw) ? Math.max(1, Math.floor(fromHeightRaw)) : 1;
        const requestedToHeight = Number.isFinite(toHeightRaw)
          ? Math.max(fromHeight, Math.floor(toHeightRaw))
          : latestPersistedHeight;
        const toHeight =
          latestPersistedHeight <= 0
            ? 0
            : Math.min(latestPersistedHeight, requestedToHeight);
        const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(1000, Math.floor(limitRaw))) : 200;
        const pageToHeight =
          toHeight > 0 && toHeight >= fromHeight
            ? Math.min(toHeight, fromHeight + limit - 1)
            : 0;
        const entityId =
          typeof msg?.['entityId'] === 'string' && msg['entityId'].trim().length > 0 ? msg['entityId'].trim().toLowerCase() : undefined;
        const eventNames = normalizeRpcStringArray(msg?.['eventNames'] ?? msg?.['events']);
        const includeInputs = msg?.['includeInputs'] === true;

        const receipts =
          pageToHeight > 0
            ? await readPersistedFrameJournals(env, { fromHeight, toHeight: pageToHeight, limit })
            : [];
        const filtered = receipts
          .map(receipt => {
            const matchedLogs = filterReceiptLogs(receipt.logs, entityId, eventNames);
            if ((entityId || eventNames.length > 0) && matchedLogs.length === 0) return null;
            return {
              height: receipt.height,
              timestamp: receipt.timestamp,
              logs: matchedLogs.length > 0 || entityId || eventNames.length > 0 ? matchedLogs : receipt.logs,
              ...(includeInputs ? { runtimeInput: receipt.runtimeInput } : {}),
            };
          })
          .filter((receipt): receipt is NonNullable<typeof receipt> => receipt !== null);

        ws.send(
          safeStringify({
            type: 'frame_receipts',
            inReplyTo: id,
            data: {
              fromHeight,
              toHeight: pageToHeight,
              returned: filtered.length,
              receipts: filtered,
            },
          }),
        );
      } catch (error) {
        ws.send(
          safeStringify({
            type: 'error',
            inReplyTo: id,
            error: (error as Error)?.message || 'Failed to load frame receipts',
          }),
        );
      }
      return;
    }

    if (type === 'find_routes') {
      if (!requireDaemonRpcAuth(ws, id, msg, env, 'inspect')) return;
      if (!env) {
        ws.send(safeStringify({ type: 'error', inReplyTo: id, error: 'Runtime not ready' }));
        return;
      }
      try {
        const sourceEntityId = String(msg?.['sourceEntityId'] || '').trim().toLowerCase();
        const targetEntityId = String(msg?.['targetEntityId'] || '').trim().toLowerCase();
        const tokenId = Number(msg?.['tokenId'] ?? 1);
        const amount = parseRpcBigInt(msg?.['amount'], 'amount');
        if (!isEntityId32(sourceEntityId) || !isEntityId32(targetEntityId)) {
          throw new Error('sourceEntityId and targetEntityId must be 32-byte hex entity ids');
        }
        if (!Number.isFinite(tokenId) || tokenId <= 0) {
          throw new Error('tokenId must be a positive integer');
        }

        const route = await resolveRpcPaymentRoute(env, sourceEntityId, targetEntityId, tokenId, amount);
        const routes = await env.gossip.getNetworkGraph().findPaths(sourceEntityId, targetEntityId, amount, tokenId);
        const selected =
          routes.find(candidate => candidate.path.join('>') === route.join('>'))
          ?? routes[0];
        if (!selected) {
          throw new Error(`No route found from ${sourceEntityId} to ${targetEntityId}`);
        }
        ws.send(
          safeStringify({
            type: 'routes',
            inReplyTo: id,
            data: {
              routes: routes.map(candidate => ({
                path: candidate.path,
                hops: candidate.hops.map(hop => ({
                  from: hop.from,
                  to: hop.to,
                  fee: hop.fee.toString(),
                  feePPM: hop.feePPM,
                })),
                totalFee: candidate.totalFee.toString(),
                senderAmount: candidate.totalAmount.toString(),
                recipientAmount: amount.toString(),
                probability: candidate.probability,
              })),
              selectedRoute: selected.path,
            },
          }),
        );
      } catch (error) {
        ws.send(safeStringify({ type: 'error', inReplyTo: id, error: (error as Error)?.message || 'Route lookup failed' }));
      }
      return;
    }

    if (type === 'queue_payment') {
      if (!requireDaemonRpcAuth(ws, id, msg, env, 'admin')) return;
      if (!env) {
        ws.send(safeStringify({ type: 'error', inReplyTo: id, error: 'Runtime not ready' }));
        return;
      }
      try {
        const sourceEntityId = String(msg?.['sourceEntityId'] || '').trim().toLowerCase();
        const targetEntityId = String(msg?.['targetEntityId'] || '').trim().toLowerCase();
        const tokenId = Number(msg?.['tokenId'] ?? 1);
        const amount = parseRpcBigInt(msg?.['amount'], 'amount');
        const mode = msg?.['mode'] === 'direct' ? 'direct' : 'htlc';
        const description = typeof msg?.['description'] === 'string' ? msg['description'].trim() : '';
        if (!isEntityId32(sourceEntityId) || !isEntityId32(targetEntityId)) {
          throw new Error('sourceEntityId and targetEntityId must be 32-byte hex entity ids');
        }
        if (!Number.isFinite(tokenId) || tokenId <= 0) {
          throw new Error('tokenId must be a positive integer');
        }
        if (amount <= 0n) {
          throw new Error('amount must be positive');
        }
        if (!getEntityReplicaById(env, sourceEntityId)) {
          throw new Error(`Source entity ${sourceEntityId} not found in runtime`);
        }

        const signerId =
          typeof msg?.['signerId'] === 'string' && msg['signerId'].trim().length > 0
            ? msg['signerId'].trim().toLowerCase()
            : resolveEntityProposerId(env, sourceEntityId, 'rpc.queue_payment');
        const route = await resolveRpcPaymentRoute(env, sourceEntityId, targetEntityId, tokenId, amount, msg?.['route']);

        let secret: string | undefined;
        let hashlock: string | undefined;
        const txData: Record<string, unknown> = {
          targetEntityId,
          tokenId,
          amount,
          route,
          ...(description ? { description } : {}),
        };

        let txType: 'directPayment' | 'htlcPayment' = 'directPayment';
        if (mode === 'htlc') {
          txType = 'htlcPayment';
          secret =
            typeof msg?.['secret'] === 'string' && msg['secret'].trim().length > 0
              ? msg['secret'].trim()
              : ethers.hexlify(ethers.randomBytes(32));
          hashlock =
            typeof msg?.['hashlock'] === 'string' && msg['hashlock'].trim().length > 0
              ? msg['hashlock'].trim()
              : hashHtlcSecret(secret);
          txData['secret'] = secret;
          txData['hashlock'] = hashlock;
        }

        const paymentTx = { type: txType, data: txData } as EntityTx;
        enqueueRuntimeInput(env, {
          runtimeTxs: [],
          entityInputs: [
            {
              entityId: sourceEntityId,
              signerId,
              entityTxs: [paymentTx],
            },
          ],
        });

        ws.send(
          safeStringify({
            type: 'payment_queued',
            inReplyTo: id,
            data: {
              sourceEntityId,
              signerId,
              targetEntityId,
              tokenId,
              amount: amount.toString(),
              route,
              mode,
              ...(description ? { description } : {}),
              ...(secret ? { secret } : {}),
              ...(hashlock ? { hashlock } : {}),
            },
          }),
        );
      } catch (error) {
        ws.send(safeStringify({ type: 'error', inReplyTo: id, error: (error as Error)?.message || 'Failed to queue payment' }));
      }
      return;
    }

    ws.send(safeStringify({ type: 'error', error: `Unknown RPC type: ${type}` }));
  };
