import { RPC_MARKET_PUBLISH_MS, type MarketSnapshotPayload } from './snapshot';
import { aggregateMarketSnapshots } from './aggregate';
import { normalizeMarketEntityId } from './identifiers';
import { encodeMarketWireMessage } from './wire';
import type {
  MarketHandlerMessage,
  MarketSocket,
  MarketSubscription,
  MarketSubscriptionContext,
} from './subscription-types';

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

const marketErrorCode = (error: unknown): string | undefined => {
  const code = (error as { code?: unknown } | null | undefined)?.code;
  return typeof code === 'string' && /^E_[A-Z0-9_]+$/.test(code) ? code : undefined;
};

const marketErrorMessage = (error: unknown): string =>
  error instanceof Error && error.message
    ? error.message
    : 'Failed to send market snapshot';

const reportHandlerError = <WS extends MarketSocket>(
  context: MarketSubscriptionContext<WS>,
  error: unknown,
  message: MarketHandlerMessage,
): void => {
  if (!context.options.onHandlerError) {
    console.error('MARKET_HANDLER_EXCEPTION', error);
    return;
  }
  try {
    context.options.onHandlerError(error, message);
  } catch (reportingError) {
    console.error('MARKET_HANDLER_ERROR_REPORT_FAILED', reportingError);
  }
};

const sendErrorOrReport = <WS extends MarketSocket>(
  context: MarketSubscriptionContext<WS>,
  ws: WS,
  inReplyTo: string | undefined,
  error: unknown,
  message: MarketHandlerMessage,
): void => {
  try {
    sendError(ws, inReplyTo, marketErrorMessage(error), marketErrorCode(error));
  } catch (sendFailure) {
    reportHandlerError(context, sendFailure, message);
  }
};

export const cleanupSubscription = <WS extends MarketSocket>(
  context: MarketSubscriptionContext<WS>,
  ws: WS,
): void => {
  if (context.subscriptions.delete(ws)) {
    context.limiter.remove(context.options.getClientIp(ws));
  }
  if (context.subscriptions.size > 0 || !context.publisherTimer) return;
  clearInterval(context.publisherTimer);
  context.publisherTimer = null;
};

export const clearSubscriptions = <WS extends MarketSocket>(
  context: MarketSubscriptionContext<WS>,
): void => {
  context.subscriptions.clear();
  context.limiter.clear();
  context.tradeObservations.clear();
  if (context.publisherTimer) clearInterval(context.publisherTimer);
  context.publisherTimer = null;
  context.publisherInFlight = false;
};

export const sendSnapshot = async <WS extends MarketSocket>(
  context: MarketSubscriptionContext<WS>,
  ws: WS,
  subscription: MarketSubscription,
): Promise<boolean> => {
  let sentAny = false;
  const pairIds = Array.from(subscription.pairIds);
  const connectedHubIds = Array.from(new Set(
    context.options.getConnectedHubEntityIds()
      .map(normalizeMarketEntityId)
      .filter((value): value is string => value !== null),
  )).sort();
  subscription.hubIds = new Set(connectedHubIds);
  const snapshots: MarketSnapshotPayload[] = (await Promise.all(
    connectedHubIds.map(hubEntityId => context.options.fetchSnapshots(
      hubEntityId, pairIds, subscription.depth,
    )),
  )).flat();
  const observedAt = Date.now();
  for (const pairId of pairIds) {
    const pairSnapshots = snapshots.filter(snapshot => snapshot.pairId === pairId);
    if (pairSnapshots.length === 0) continue;
    const jurisdictionRefs = Array.from(new Set(pairSnapshots.map(snapshot => snapshot.jurisdictionRef))).sort();
    for (const jurisdictionRef of jurisdictionRefs) {
      const scopedSnapshots = pairSnapshots.filter(snapshot => snapshot.jurisdictionRef === jurisdictionRef);
      const payload = aggregateMarketSnapshots(
        scopedSnapshots,
        subscription.depth,
        observedAt,
        context.tradeObservations,
      );
      subscription.seq += 1;
      ws.send(encodeMarketWireMessage({
        type: 'market_snapshot',
        id: `market_${observedAt}_${subscription.seq}`,
        timestamp: observedAt,
        payload,
      }));
      sentAny = true;
    }
  }
  return sentAny;
};

export const sendNoMarketStatus = (
  ws: MarketSocket,
  subscription: MarketSubscription,
  inReplyTo?: string,
): void => {
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

export const handleSnapshotFailure = <WS extends MarketSocket>(
  context: MarketSubscriptionContext<WS>,
  ws: WS,
  message: MarketHandlerMessage,
  inReplyTo: string | undefined,
  error: unknown,
): void => {
  cleanupSubscription(context, ws);
  reportHandlerError(context, error, message);
  sendErrorOrReport(context, ws, inReplyTo, error, message);
};

const publishSnapshots = async <WS extends MarketSocket>(
  context: MarketSubscriptionContext<WS>,
): Promise<void> => {
  if (context.publisherInFlight || context.subscriptions.size === 0) return;
  context.publisherInFlight = true;
  try {
    for (const [ws, subscription] of context.subscriptions) {
      try {
        await sendSnapshot(context, ws, subscription);
      } catch (error) {
        handleSnapshotFailure(context, ws, { type: 'market_publish' }, undefined, error);
      }
    }
  } finally {
    context.publisherInFlight = false;
  }
};

export const ensurePublisher = <WS extends MarketSocket>(
  context: MarketSubscriptionContext<WS>,
): void => {
  if (context.publisherTimer) return;
  context.publisherTimer = setInterval(() => {
    void publishSnapshots(context);
  }, RPC_MARKET_PUBLISH_MS);
};
