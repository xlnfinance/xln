import {
  normalizeMarketEntityId,
  normalizeMarketPairId,
  RPC_MARKET_DEFAULT_DEPTH,
  RPC_MARKET_MAX_DEPTH,
  RPC_MARKET_PUBLISH_MS,
  type MarketSnapshotPayload,
} from './market-snapshot';
import { MarketSubscriptionLimiter, type MarketSubscriptionLimiterSnapshot } from './market-subscription-limiter';
import {
  encodeMarketWireMessage,
  isMarketMessageType,
  type MarketWireRequest,
} from './market-wire';

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
  onHandlerError?: (error: unknown, msg: MarketWireRequest | { type: 'market_publish' }) => void;
};

export type MarketSubscriptionStack<WS extends MarketSocket> = {
  cleanup: (ws: WS) => void;
  clear: () => void;
  handleMessage: (ws: WS, msg: MarketWireRequest) => Promise<void>;
  isMarketMessageType: typeof isMarketMessageType;
  snapshot: () => MarketSubscriptionLimiterSnapshot;
};

export { isMarketMessageType } from './market-wire';

const valuesFor = (msg: MarketWireRequest, kind: 'hub' | 'pair'): unknown[] => {
  const plural = kind === 'hub'
    ? ('hubEntityIds' in msg ? msg.hubEntityIds : undefined)
    : ('pairs' in msg ? msg.pairs : undefined);
  if (Array.isArray(plural)) return plural;
  const single = kind === 'hub'
    ? ('hubEntityId' in msg ? msg.hubEntityId : undefined)
    : ('pairId' in msg ? msg.pairId : undefined);
  return single ? [single] : [];
};

const sendError = (ws: MarketSocket, inReplyTo: string | undefined, error: string, code?: string): void => {
  ws.send(encodeMarketWireMessage({
    type: 'error',
    ...(inReplyTo ? { inReplyTo } : {}),
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

  const reportHandlerError = (
    error: unknown,
    msg: MarketWireRequest | { type: 'market_publish' },
  ): void => {
    if (!options.onHandlerError) {
      console.error('MARKET_HANDLER_EXCEPTION', error);
      return;
    }
    try {
      options.onHandlerError(error, msg);
    } catch (reportingError) {
      console.error('MARKET_HANDLER_ERROR_REPORT_FAILED', reportingError);
    }
  };

  const sendErrorOrReport = (
    ws: WS,
    inReplyTo: string | undefined,
    error: string,
    code: string | undefined,
    msg: MarketWireRequest | { type: 'market_publish' },
  ): void => {
    try {
      sendError(ws, inReplyTo, error, code);
    } catch (sendErrorFailure) {
      reportHandlerError(sendErrorFailure, msg);
    }
  };

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
        ws.send(encodeMarketWireMessage({
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

  const sendNoMarketStatus = (ws: WS, subscription: MarketSubscription, inReplyTo?: string): void => {
    ws.send(encodeMarketWireMessage({
      type: 'market_status',
      ...(inReplyTo ? { inReplyTo } : {}),
      status: 'no_market',
      data: {
        hubEntityIds: Array.from(subscription.hubIds),
        pairs: Array.from(subscription.pairIds),
        depth: subscription.depth,
      },
    }));
  };

  const publish = async (): Promise<void> => {
    if (publisherInFlight || subscriptions.size === 0) return;
    publisherInFlight = true;
    try {
      for (const [ws, subscription] of subscriptions.entries()) {
        try {
          await sendSnapshot(ws, subscription);
        } catch (error) {
          cleanup(ws);
          reportHandlerError(error, { type: 'market_publish' });
          sendErrorOrReport(
            ws,
            undefined,
            marketErrorMessage(error, 'Failed to send market snapshot'),
            marketErrorCode(error),
            { type: 'market_publish' },
          );
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

  const handleMessage = async (ws: WS, msg: MarketWireRequest): Promise<void> => {
    const type = msg.type;
    const id = msg.id;

    if (type === 'market_subscribe') {
      if (options.isReady && !options.isReady()) {
        sendError(ws, id, options.readyError || 'Runtime not ready');
        return;
      }

      const hubIds = Array.from(new Set(valuesFor(msg, 'hub').map(normalizeMarketEntityId).filter(Boolean))) as string[];
      const pairIds = Array.from(new Set(valuesFor(msg, 'pair').map(normalizeMarketPairId).filter(Boolean))) as string[];
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

      const replace = msg.replace === true;
      const depthRaw = Number(msg.depth);
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

      try {
        const sentAny = await sendSnapshot(ws, subscription);
        if (!sentAny) sendNoMarketStatus(ws, subscription, id);
      } catch (error) {
        cleanup(ws);
        reportHandlerError(error, msg);
        sendErrorOrReport(
          ws,
          id,
          marketErrorMessage(error, 'Failed to send market snapshot'),
          marketErrorCode(error),
          msg,
        );
      }
      return;
    }

    if (type === 'market_unsubscribe') {
      const existing = subscriptions.get(ws);
      if (!existing) {
        ws.send(encodeMarketWireMessage({ type: 'ack', inReplyTo: id, status: 'market_unsubscribed' }));
        return;
      }

      const hubIds = Array.from(new Set(valuesFor(msg, 'hub').map(normalizeMarketEntityId).filter(Boolean))) as string[];
      const pairIds = Array.from(new Set(valuesFor(msg, 'pair').map(normalizeMarketPairId).filter(Boolean))) as string[];
      if (hubIds.length === 0 && pairIds.length === 0) {
        cleanup(ws);
        ws.send(encodeMarketWireMessage({ type: 'ack', inReplyTo: id, status: 'market_unsubscribed' }));
        return;
      }

      for (const hubEntityId of hubIds) existing.hubIds.delete(hubEntityId);
      for (const pairId of pairIds) existing.pairIds.delete(pairId);
      if (existing.hubIds.size === 0 || existing.pairIds.size === 0) cleanup(ws);
      ws.send(encodeMarketWireMessage({ type: 'ack', inReplyTo: id, status: 'market_unsubscribed' }));
      return;
    }

    const existing = subscriptions.get(ws);
    if (!existing) {
      sendError(ws, id, 'No active market subscription');
      return;
    }
    try {
      const sentAny = await sendSnapshot(ws, existing);
      if (!sentAny) sendNoMarketStatus(ws, existing, id);
      ws.send(encodeMarketWireMessage({ type: 'ack', inReplyTo: id, status: 'market_snapshot_sent' }));
    } catch (error) {
      cleanup(ws);
      reportHandlerError(error, msg);
      sendErrorOrReport(
        ws,
        id,
        marketErrorMessage(error, 'Failed to send market snapshot'),
        marketErrorCode(error),
        msg,
      );
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
