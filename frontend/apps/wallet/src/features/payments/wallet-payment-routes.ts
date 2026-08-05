import type {
  PaymentDeliveryMode,
  RuntimeAdapterPaymentRoute,
  RuntimeAdapterPaymentRoutesResponse,
} from '@xln/runtime/api/public/runtime-module';

const ENTITY_ID = /^0x[0-9a-f]{64}$/;
const UINT = /^(0|[1-9][0-9]*)$/;

export type WalletPaymentRouteView = Readonly<{
  path: readonly string[];
  totalFee: bigint;
  senderAmount: bigint;
  recipientAmount: bigint;
  probability: number;
}>;

export const walletPaymentRouteErrorText = (error: unknown): string => {
  const message = error instanceof Error ? error.message : String(error);
  return /no payment route/i.test(message)
    ? 'No route has enough real capacity for this amount'
    : message;
};

const amount = (value: string, field: string): bigint => {
  if (!UINT.test(value)) throw new Error(`WALLET_PAYMENT_ROUTE_${field}_INVALID`);
  return BigInt(value);
};

const routeView = (
  route: RuntimeAdapterPaymentRoute,
  sourceEntityId: string,
  targetEntityId: string,
  recipientAmount: bigint,
): WalletPaymentRouteView => {
  const path = route.path.map(value => String(value || '').trim().toLowerCase());
  if (
    path.length < 2 ||
    path.some(entityId => !ENTITY_ID.test(entityId)) ||
    path[0] !== sourceEntityId ||
    path.at(-1) !== targetEntityId
  ) {
    throw new Error('WALLET_PAYMENT_ROUTE_PATH_INVALID');
  }
  if (route.hops.length !== path.length - 1 || route.hops.some((hop, index) => (
    String(hop.from || '').trim().toLowerCase() !== path[index] ||
    String(hop.to || '').trim().toLowerCase() !== path[index + 1]
  ))) {
    throw new Error('WALLET_PAYMENT_ROUTE_HOPS_INVALID');
  }
  const totalFee = amount(route.totalFee, 'FEE');
  const senderAmount = amount(route.senderAmount, 'SENDER_AMOUNT');
  const projectedRecipientAmount = amount(route.recipientAmount, 'RECIPIENT_AMOUNT');
  if (projectedRecipientAmount !== recipientAmount || senderAmount !== recipientAmount + totalFee) {
    throw new Error('WALLET_PAYMENT_ROUTE_AMOUNT_MISMATCH');
  }
  const probability = Number(route.probability);
  if (!Number.isFinite(probability) || probability < 0 || probability > 1) {
    throw new Error('WALLET_PAYMENT_ROUTE_PROBABILITY_INVALID');
  }
  return Object.freeze({
    path: Object.freeze(path),
    totalFee,
    senderAmount,
    recipientAmount: projectedRecipientAmount,
    probability,
  });
};

const allowedForMode = (route: WalletPaymentRouteView, mode: PaymentDeliveryMode): boolean => {
  if (mode === 'direct') return route.path.length === 2;
  if (mode === 'trusted') return route.path.length === 3 && route.totalFee === 0n;
  return true;
};

export const projectWalletPaymentRoutes = (input: Readonly<{
  response: RuntimeAdapterPaymentRoutesResponse;
  sourceEntityId: string;
  targetEntityId: string;
  recipientAmount: bigint;
  deliveryMode: PaymentDeliveryMode;
}>): readonly WalletPaymentRouteView[] => {
  const sourceEntityId = String(input.sourceEntityId || '').trim().toLowerCase();
  const targetEntityId = String(input.targetEntityId || '').trim().toLowerCase();
  if (!ENTITY_ID.test(sourceEntityId) || !ENTITY_ID.test(targetEntityId)) {
    throw new Error('WALLET_PAYMENT_ROUTE_ENDPOINT_INVALID');
  }
  const routes = input.response.routes
    .map(route => routeView(route, sourceEntityId, targetEntityId, input.recipientAmount))
    .filter(route => allowedForMode(route, input.deliveryMode))
    .toSorted((left, right) => {
      if (left.totalFee !== right.totalFee) return left.totalFee < right.totalFee ? -1 : 1;
      if (left.probability !== right.probability) return right.probability - left.probability;
      return left.path.join(':').localeCompare(right.path.join(':'));
    });
  return Object.freeze(routes);
};
