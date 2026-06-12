import {
  normalizeMarketEntityId,
  normalizeMarketPairId,
  RPC_MARKET_DEFAULT_DEPTH,
  RPC_MARKET_MAX_DEPTH,
  RPC_MARKET_PUBLISH_MS,
  type MarketSnapshotPayload,
} from '../market-snapshot';
import { MarketSubscriptionLimiter, type MarketSubscriptionLimiterSnapshot } from '../market-subscription-limiter';
import { safeStringify } from '../serialization-utils';

export type MarketSubscription = {
  hubIds: Set<string>;
  pairIds: Set<string>;
  depth: number;
  seq: number;
};

type MarketSocket = {
  send(payload: string): void;
};

export type MarketSubscriptionStackOptions<WS extends MarketSocket> = {
  maxSubscriptions: number;
  maxSubscriptionsPerIp: number;
  maxCellsPerSubscription: number;
  getClientIp: (ws: WS) => string;
  fetchSnapshots: (hubEntityId: string, pairIds: string[], depth: number) => Promise<MarketSnapshotPayload[]> | MarketSnapshotPayload[];
  isReady?: () => boolean;
  readyError?: string;
  onHandlerError?: (error: unknown, msg: Record<string, unknown>) => void;
};

export type MarketSubscriptionStack<WS extends MarketSocket> = {
  cleanup: (ws: WS) => void;
  clear: () => void;
  handleMessage: (ws: WS, msg: Record<string, unknown>) => Promise<void>;
  isMarketMessageType: (type: unknown) => type is MarketMessageType;
  snapshot: () => MarketSubscriptionLimiterSnapshot;
};

type MarketMessageType = 'market_subscribe' | 'market_unsubscribe' | 'market_snapshot_request';

const marketMessageTypes = new Set<unknown>(['market_subscribe', 'market_unsubscribe', 'market_snapshot_request']);

export const isMarketMessageType = (type: unknown): type is MarketMessageType => marketMessageTypes.has(type);

const valuesFor = (msg: Record<string, unknown>, pluralKey: string, singleKey: string): unknown[] => {
  const plural = msg[pluralKey];
  if (Array.isArray(plural)) return plural;
  const single = msg[singleKey];
  return single ? [single] : [];
};

const sendError = (ws: MarketSocket, inReplyTo: unknown, error: string, code?: string): void => {
  ws.send(safeStringify({
    type: 'error',
    inReplyTo,
    ...(code ? { code } : {}),
    error,
  }));
};

const marketErrorCode = (error: unknown): string | undefined => {
  const code = (error as { code?: unknown } | null | undefined)?.code;
  return typeof code === 'string' && /^E_[A-Z0-9_]+$/.test(code) ? code : undefined;
};

const marketErrorMessage = (error: unknown, fallback: string): string => {
  if (error instanceof Error && error.message) return error.message;
  return fallback;
};

export const createMarketSubscriptionStack = <WS extends MarketSocket>(
  options: MarketSubscriptionStackOptions<WS>,
): MarketSubscriptionStack<WS> => {
  const subscriptions = new Map<WS, MarketSubscription>();
  const limiter = new MarketSubscriptionLimiter(
    options.maxSubscriptions,
    options.maxSubscriptionsPerIp,
    options.maxCellsPerSubscription,
  );
  let publisherTimer: ReturnType<typeof setInterval> | null = null;
  let publisherInFlight = false;

  const cleanup = (ws: WS): void => {
    const existing = subscriptions.get(ws);
    if (existing) {
      limiter.remove(options.getClientIp(ws));
      subscriptions.delete(ws);
    }
    if (subscriptions.size > 0) return;
    if (!publisherTimer) return;
    clearInterval(publisherTimer);
    publisherTimer = null;
  };

  const clear = (): void => {
    subscriptions.clear();
    limiter.clear();
    if (publisherTimer) {
      clearInterval(publisherTimer);
      publisherTimer = null;
    }
    publisherInFlight = false;
  };

  const sendSnapshot = async (ws: WS, subscription: MarketSubscription): Promise<boolean> => {
    let sentAny = false;
    const pairIds = Array.from(subscription.pairIds);
    for (const hubEntityId of subscription.hubIds) {
      const snapshots = await options.fetchSnapshots(hubEntityId, pairIds, subscription.depth);
      for (const payload of snapshots) {
        subscription.seq += 1;
        ws.send(safeStringify({
          type: 'market_snapshot',
          id: `market_${Date.now()}_${subscription.seq}`,
          timestamp: Date.now(),
          payload,
        }));
        sentAny = true;
      }
    }
    return sentAny;
  };

  const publish = async (): Promise<void> => {
    if (publisherInFlight || subscriptions.size === 0) return;
    publisherInFlight = true;
    try {
      for (const [ws, subscription] of subscriptions.entries()) {
        try {
          await sendSnapshot(ws, subscription);
        } catch (error) {
          sendError(
            ws,
            undefined,
            marketErrorMessage(error, 'Failed to send market snapshot'),
            marketErrorCode(error),
          );
          cleanup(ws);
          options.onHandlerError?.(error, { type: 'market_publish' });
        }
      }
    } finally {
      publisherInFlight = false;
    }
  };

  const ensurePublisher = (): void => {
    if (publisherTimer) return;
    publisherTimer = setInterval(() => {
      void publish();
    }, RPC_MARKET_PUBLISH_MS);
  };

  const handleMessage = async (ws: WS, msg: Record<string, unknown>): Promise<void> => {
    const type = msg['type'];
    const id = msg['id'];
    if (!isMarketMessageType(type)) return;

    if (type === 'market_subscribe') {
      if (options.isReady && !options.isReady()) {
        sendError(ws, id, options.readyError || 'Runtime not ready');
        return;
      }

      const hubIds = Array.from(new Set(valuesFor(msg, 'hubEntityIds', 'hubEntityId').map(normalizeMarketEntityId).filter(Boolean))) as string[];
      const pairIds = Array.from(new Set(valuesFor(msg, 'pairs', 'pairId').map(normalizeMarketPairId).filter(Boolean))) as string[];
      if (hubIds.length === 0 || pairIds.length === 0) {
        sendError(ws, id, 'market_subscribe requires valid hubEntityId(s) and pair(s)');
        return;
      }

      const existing = subscriptions.get(ws);
      if (!existing) {
        const decision = limiter.canOpen(options.getClientIp(ws));
        if (!decision.ok) {
          sendError(ws, id, decision.error, decision.code);
          return;
        }
      }

      const replace = msg['replace'] === true;
      const depthRaw = Number(msg['depth']);
      const depth = Number.isFinite(depthRaw)
        ? Math.max(1, Math.min(Math.floor(depthRaw), RPC_MARKET_MAX_DEPTH))
        : RPC_MARKET_DEFAULT_DEPTH;
      const nextHubIds = replace || !existing ? new Set<string>() : new Set(existing.hubIds);
      const nextPairIds = replace || !existing ? new Set<string>() : new Set(existing.pairIds);
      for (const hubEntityId of hubIds) nextHubIds.add(hubEntityId);
      for (const pairId of pairIds) nextPairIds.add(pairId);

      const cellCount = nextHubIds.size * nextPairIds.size;
      if (cellCount > options.maxCellsPerSubscription) {
        sendError(ws, id, `market subscription too broad: cells=${cellCount} max=${options.maxCellsPerSubscription}`, 'E_BAD_QUERY');
        return;
      }

      const subscription = existing || { hubIds: new Set<string>(), pairIds: new Set<string>(), depth, seq: 0 };
      subscription.hubIds = nextHubIds;
      subscription.pairIds = nextPairIds;
      subscription.depth = depth;
      if (!existing) limiter.add(options.getClientIp(ws));
      subscriptions.set(ws, subscription);
      ensurePublisher();

      ws.send(safeStringify({
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

      try {
        await sendSnapshot(ws, subscription);
      } catch (error) {
        sendError(
          ws,
          id,
          marketErrorMessage(error, 'Failed to send market snapshot'),
          marketErrorCode(error),
        );
        cleanup(ws);
        options.onHandlerError?.(error, msg);
      }
      return;
    }

    if (type === 'market_unsubscribe') {
      const existing = subscriptions.get(ws);
      if (!existing) {
        ws.send(safeStringify({ type: 'ack', inReplyTo: id, status: 'market_unsubscribed' }));
        return;
      }

      const hubIds = Array.from(new Set(valuesFor(msg, 'hubEntityIds', 'hubEntityId').map(normalizeMarketEntityId).filter(Boolean))) as string[];
      const pairIds = Array.from(new Set(valuesFor(msg, 'pairs', 'pairId').map(normalizeMarketPairId).filter(Boolean))) as string[];
      if (hubIds.length === 0 && pairIds.length === 0) {
        cleanup(ws);
        ws.send(safeStringify({ type: 'ack', inReplyTo: id, status: 'market_unsubscribed' }));
        return;
      }

      for (const hubEntityId of hubIds) existing.hubIds.delete(hubEntityId);
      for (const pairId of pairIds) existing.pairIds.delete(pairId);
      if (existing.hubIds.size === 0 || existing.pairIds.size === 0) cleanup(ws);
      ws.send(safeStringify({ type: 'ack', inReplyTo: id, status: 'market_unsubscribed' }));
      return;
    }

    const existing = subscriptions.get(ws);
    if (!existing) {
      sendError(ws, id, 'No active market subscription');
      return;
    }
    try {
      await sendSnapshot(ws, existing);
      ws.send(safeStringify({ type: 'ack', inReplyTo: id, status: 'market_snapshot_sent' }));
    } catch (error) {
      cleanup(ws);
      sendError(
        ws,
        id,
        marketErrorMessage(error, 'Failed to send market snapshot'),
        marketErrorCode(error),
      );
      options.onHandlerError?.(error, msg);
    }
  };

  return {
    cleanup,
    clear,
    handleMessage,
    isMarketMessageType,
    snapshot: () => limiter.snapshot(),
  };
};
