import { RPC_MARKET_PUBLISH_MS } from './market-snapshot';
import { encodeMarketWireMessage } from './market-wire';
import type {
  MarketHandlerMessage,
  MarketSocket,
  MarketSubscription,
  MarketSubscriptionContext,
} from './market-subscription-types';

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
  for (const hubEntityId of subscription.hubIds) {
    const snapshots = await context.options.fetchSnapshots(
      hubEntityId,
      pairIds,
      subscription.depth,
    );
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
