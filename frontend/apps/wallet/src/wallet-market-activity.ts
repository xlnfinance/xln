import type { WalletPortfolioMath } from './wallet-portfolio-model';
import {
  optionalRuntimeEntityId,
  optionalRuntimeString,
  requireRuntimeEnum,
  requireRuntimeInteger,
  requireRuntimeRecord,
  requireRuntimeString,
} from './wallet-runtime-decode';

export type WalletMarketActivityKind = 'all' | 'onchain' | 'offchain';

export type WalletMarketActivityEvent = Readonly<{
  id: string;
  height: number;
  timestamp: number;
  kind: 'onchain' | 'offchain';
  direction: 'in' | 'out' | 'neutral';
  type: string;
  title: string;
  subtitle: string;
  status: string;
  rawType: string;
  counterpartyId?: string;
  orderId?: string;
  amountLabel?: string;
}>;

export type WalletMarketActivityPage = Readonly<{
  events: readonly WalletMarketActivityEvent[];
  nextBeforeHeight: number | null;
}>;

const integerAmount = (value: unknown, label: string): string | undefined => {
  const amount = optionalRuntimeString(value, label);
  if (amount !== undefined && !/^-?\d+$/.test(amount)) throw new Error(`${label}_INVALID`);
  return amount;
};

export const decodeWalletMarketActivity = (
  value: unknown,
  math: WalletPortfolioMath,
): WalletMarketActivityPage => {
  const root = requireRuntimeRecord(value, 'WALLET_MARKET_ACTIVITY');
  if (root['ok'] !== true || !Array.isArray(root['events'])) {
    throw new Error('WALLET_MARKET_ACTIVITY_INVALID');
  }
  const events = root['events'].map((raw): WalletMarketActivityEvent => {
    const event = requireRuntimeRecord(raw, 'WALLET_MARKET_ACTIVITY_EVENT');
    const tokenId = event['tokenId'] === undefined
      ? undefined
      : requireRuntimeInteger(event['tokenId'], 'WALLET_MARKET_ACTIVITY_TOKEN', 1);
    const amount = integerAmount(event['amount'], 'WALLET_MARKET_ACTIVITY_AMOUNT');
    const counterpartyId = optionalRuntimeEntityId(
      event['counterpartyId'],
      'WALLET_MARKET_ACTIVITY_COUNTERPARTY',
    );
    const orderId = optionalRuntimeString(event['orderId'], 'WALLET_MARKET_ACTIVITY_ORDER');
    return {
      id: requireRuntimeString(event['id'], 'WALLET_MARKET_ACTIVITY_ID'),
      height: requireRuntimeInteger(event['height'], 'WALLET_MARKET_ACTIVITY_HEIGHT', 1),
      timestamp: requireRuntimeInteger(event['timestamp'], 'WALLET_MARKET_ACTIVITY_TIMESTAMP'),
      kind: requireRuntimeEnum(event['kind'], ['onchain', 'offchain'], 'WALLET_MARKET_ACTIVITY_KIND'),
      direction: requireRuntimeEnum(
        event['direction'],
        ['in', 'out', 'neutral'],
        'WALLET_MARKET_ACTIVITY_DIRECTION',
      ),
      type: requireRuntimeString(event['type'], 'WALLET_MARKET_ACTIVITY_TYPE'),
      title: requireRuntimeString(event['title'], 'WALLET_MARKET_ACTIVITY_TITLE'),
      subtitle: requireRuntimeString(event['subtitle'], 'WALLET_MARKET_ACTIVITY_SUBTITLE'),
      status: requireRuntimeString(event['status'], 'WALLET_MARKET_ACTIVITY_STATUS'),
      rawType: requireRuntimeString(event['rawType'], 'WALLET_MARKET_ACTIVITY_RAW_TYPE'),
      ...(counterpartyId ? { counterpartyId } : {}),
      ...(orderId ? { orderId } : {}),
      ...(amount ? {
        amountLabel: tokenId === undefined ? amount : math.formatTokenAmount(tokenId, BigInt(amount)),
      } : {}),
    };
  });
  const cursor = root['nextBeforeHeight'];
  return {
    events,
    nextBeforeHeight: cursor === null
      ? null
      : requireRuntimeInteger(cursor, 'WALLET_MARKET_ACTIVITY_CURSOR', 1),
  };
};
