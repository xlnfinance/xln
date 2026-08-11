import { MarketSubscriptionLimiter } from './market-subscription-limiter';
import {
  cleanupSubscription,
  clearSubscriptions,
} from './market-subscription-lifecycle';
import { handleMarketMessage } from './market-subscription-handlers';
import type {
  MarketSocket,
  MarketSubscriptionContext,
  MarketSubscriptionStack,
  MarketSubscriptionStackOptions,
} from './market-subscription-types';
import { isMarketMessageType } from './market-wire';

export type {
  MarketSubscriptionStack,
  MarketSubscriptionStackOptions,
} from './market-subscription-types';

export const createMarketSubscriptionStack = <WS extends MarketSocket>(
  options: MarketSubscriptionStackOptions<WS>,
): MarketSubscriptionStack<WS> => {
  const context: MarketSubscriptionContext<WS> = {
    options,
    subscriptions: new Map(),
    limiter: new MarketSubscriptionLimiter(
      options.maxSubscriptions,
      options.maxSubscriptionsPerIp,
      options.maxCellsPerSubscription,
    ),
    publisherTimer: null,
    publisherInFlight: false,
  };
  return {
    cleanup: ws => cleanupSubscription(context, ws),
    clear: () => clearSubscriptions(context),
    handleMessage: (ws, message) => handleMarketMessage(context, ws, message),
    isMarketMessageType,
    snapshot: () => context.limiter.snapshot(),
  };
};
