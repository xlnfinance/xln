import {
  normalizeMarketEntityId,
  normalizeMarketPairId,
  RPC_MARKET_DEFAULT_DEPTH,
  RPC_MARKET_MAX_DEPTH,
  RPC_MARKET_PUBLISH_MS,
} from './market-snapshot';
import {
  cleanupSubscription,
  ensurePublisher,
  handleSnapshotFailure,
  sendNoMarketStatus,
  sendSnapshot,
} from './market-subscription-lifecycle';
import type {
  MarketSocket,
  MarketSubscription,
  MarketSubscriptionContext,
} from './market-subscription-types';
import { encodeMarketWireMessage, type MarketWireRequest } from './market-wire';

const valuesFor = (
  message: MarketWireRequest,
  kind: 'hub' | 'pair',
): unknown[] => {
  const plural = kind === 'hub'
    ? ('hubEntityIds' in message ? message.hubEntityIds : undefined)
    : ('pairs' in message ? message.pairs : undefined);
  if (Array.isArray(plural)) return plural;
  const single = kind === 'hub'
    ? ('hubEntityId' in message ? message.hubEntityId : undefined)
    : ('pairId' in message ? message.pairId : undefined);
  return single ? [single] : [];
};

const normalizedValues = (
  message: MarketWireRequest,
  kind: 'hub' | 'pair',
): string[] => {
  const normalize = kind === 'hub' ? normalizeMarketEntityId : normalizeMarketPairId;
  return Array.from(new Set(
    valuesFor(message, kind)
      .map(normalize)
      .filter((value): value is string => value !== null),
  ));
};

const sendError = (
  ws: MarketSocket,
  inReplyTo: string | undefined,
  error: string,
  code?: string,
): void => {
  ws.send(encodeMarketWireMessage({
    type: 'error',
    ...(inReplyTo ? { inReplyTo } : {}),
    ...(code ? { code } : {}),
    error,
  }));
};

const requestedDepth = (depth: unknown): number => {
  const numericDepth = Number(depth);
  return Number.isFinite(numericDepth)
    ? Math.max(1, Math.min(Math.floor(numericDepth), RPC_MARKET_MAX_DEPTH))
    : RPC_MARKET_DEFAULT_DEPTH;
};

const buildSubscription = (
  existing: MarketSubscription | undefined,
  hubIds: string[],
  pairIds: string[],
  depth: number,
  replace: boolean,
): MarketSubscription => {
  const hubSet = replace || !existing ? new Set<string>() : new Set(existing.hubIds);
  const pairSet = replace || !existing ? new Set<string>() : new Set(existing.pairIds);
  hubIds.forEach(hubId => hubSet.add(hubId));
  pairIds.forEach(pairId => pairSet.add(pairId));
  return {
    hubIds: hubSet,
    pairIds: pairSet,
    depth,
    seq: existing?.seq ?? 0,
  };
};

const sendSubscriptionAck = (
  ws: MarketSocket,
  id: string,
  subscription: MarketSubscription,
): void => {
  ws.send(encodeMarketWireMessage({
    type: 'ack',
    inReplyTo: id,
    status: 'market_subscribed',
    data: {
      hubEntityIds: Array.from(subscription.hubIds),
      pairs: Array.from(subscription.pairIds),
      depth: subscription.depth,
      intervalMs: RPC_MARKET_PUBLISH_MS,
    },
  }));
};

const handleSubscribe = async <WS extends MarketSocket>(
  context: MarketSubscriptionContext<WS>,
  ws: WS,
  message: Extract<MarketWireRequest, { type: 'market_subscribe' }>,
): Promise<void> => {
  const { options, subscriptions, limiter } = context;
  if (options.isReady && !options.isReady()) {
    sendError(ws, message.id, options.readyError || 'Runtime not ready');
    return;
  }
  const hubIds = normalizedValues(message, 'hub');
  const pairIds = normalizedValues(message, 'pair');
  if (hubIds.length === 0 || pairIds.length === 0) {
    sendError(ws, message.id, 'market_subscribe requires valid hubEntityId(s) and pair(s)');
    return;
  }

  const existing = subscriptions.get(ws);
  const admission = existing ? { ok: true as const } : limiter.canOpen(options.getClientIp(ws));
  if (!admission.ok) {
    sendError(ws, message.id, admission.error, admission.code);
    return;
  }

  const subscription = buildSubscription(
    existing,
    hubIds,
    pairIds,
    requestedDepth(message.depth),
    message.replace === true,
  );
  const cellCount = subscription.hubIds.size * subscription.pairIds.size;
  if (cellCount > options.maxCellsPerSubscription) {
    sendError(
      ws,
      message.id,
      `market subscription too broad: cells=${cellCount} max=${options.maxCellsPerSubscription}`,
      'E_BAD_QUERY',
    );
    return;
  }

  if (!existing) limiter.add(options.getClientIp(ws));
  subscriptions.set(ws, subscription);
  ensurePublisher(context);
  sendSubscriptionAck(ws, message.id, subscription);
  try {
    const sentAny = await sendSnapshot(context, ws, subscription);
    if (!sentAny) sendNoMarketStatus(ws, subscription, message.id);
  } catch (error) {
    handleSnapshotFailure(context, ws, message, message.id, error);
  }
};

const sendUnsubscribeAck = (ws: MarketSocket, id: string): void => {
  ws.send(encodeMarketWireMessage({
    type: 'ack',
    inReplyTo: id,
    status: 'market_unsubscribed',
  }));
};

const handleUnsubscribe = <WS extends MarketSocket>(
  context: MarketSubscriptionContext<WS>,
  ws: WS,
  message: Extract<MarketWireRequest, { type: 'market_unsubscribe' }>,
): void => {
  const existing = context.subscriptions.get(ws);
  if (!existing) {
    sendUnsubscribeAck(ws, message.id);
    return;
  }
  const hubIds = normalizedValues(message, 'hub');
  const pairIds = normalizedValues(message, 'pair');
  if (hubIds.length === 0 && pairIds.length === 0) {
    cleanupSubscription(context, ws);
    sendUnsubscribeAck(ws, message.id);
    return;
  }
  hubIds.forEach(hubId => existing.hubIds.delete(hubId));
  pairIds.forEach(pairId => existing.pairIds.delete(pairId));
  if (existing.hubIds.size === 0 || existing.pairIds.size === 0) {
    cleanupSubscription(context, ws);
  }
  sendUnsubscribeAck(ws, message.id);
};

const handleSnapshotRequest = async <WS extends MarketSocket>(
  context: MarketSubscriptionContext<WS>,
  ws: WS,
  message: Extract<MarketWireRequest, { type: 'market_snapshot_request' }>,
): Promise<void> => {
  const existing = context.subscriptions.get(ws);
  if (!existing) {
    sendError(ws, message.id, 'No active market subscription');
    return;
  }
  try {
    const sentAny = await sendSnapshot(context, ws, existing);
    if (!sentAny) sendNoMarketStatus(ws, existing, message.id);
    ws.send(encodeMarketWireMessage({
      type: 'ack',
      inReplyTo: message.id,
      status: 'market_snapshot_sent',
    }));
  } catch (error) {
    handleSnapshotFailure(context, ws, message, message.id, error);
  }
};

export const handleMarketMessage = async <WS extends MarketSocket>(
  context: MarketSubscriptionContext<WS>,
  ws: WS,
  message: MarketWireRequest,
): Promise<void> => {
  if (message.type === 'market_subscribe') {
    await handleSubscribe(context, ws, message);
    return;
  }
  if (message.type === 'market_unsubscribe') {
    handleUnsubscribe(context, ws, message);
    return;
  }
  await handleSnapshotRequest(context, ws, message);
};
