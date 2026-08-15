import type { MarketSnapshotPayload } from './snapshot';
import type { RelayTradeObservationStore } from './aggregate';
import type { MarketSubscriptionLimiter, MarketSubscriptionLimiterSnapshot } from './subscription-limiter';
import type { isMarketMessageType, MarketWireRequest } from './wire';

export type MarketSubscription = {
  followsConnectedHubs: boolean;
  hubIds: Set<string>;
  pairIds: Set<string>;
  depth: number;
  seq: number;
};

export type MarketSocket = {
  send(payload: string): void;
};

export type MarketSubscriptionStackOptions<WS extends MarketSocket> = {
  maxSubscriptions: number;
  maxSubscriptionsPerIp: number;
  maxCellsPerSubscription: number;
  getClientIp: (ws: WS) => string;
  /** Canonical venue scope: every currently connected Hub on this relay. */
  getConnectedHubEntityIds: () => string[];
  fetchSnapshots: (
    hubEntityId: string,
    pairIds: string[],
    depth: number,
  ) => Promise<MarketSnapshotPayload[]> | MarketSnapshotPayload[];
  isReady?: () => boolean;
  readyError?: string;
  onHandlerError?: (
    error: unknown,
    message: MarketWireRequest | MarketPublishMessage,
  ) => void;
};

export type MarketSubscriptionStack<WS extends MarketSocket> = {
  cleanup: (ws: WS) => void;
  clear: () => void;
  handleMessage: (ws: WS, message: MarketWireRequest) => Promise<void>;
  isMarketMessageType: typeof isMarketMessageType;
  snapshot: () => MarketSubscriptionLimiterSnapshot;
};

export type MarketSubscriptionContext<WS extends MarketSocket> = {
  options: MarketSubscriptionStackOptions<WS>;
  subscriptions: Map<WS, MarketSubscription>;
  limiter: MarketSubscriptionLimiter;
  publisherTimer: ReturnType<typeof setInterval> | null;
  publisherInFlight: boolean;
  tradeObservations: RelayTradeObservationStore;
};

type MarketPublishMessage = { type: 'market_publish' };
export type MarketHandlerMessage = MarketWireRequest | MarketPublishMessage;
