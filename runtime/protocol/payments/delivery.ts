import { HTLC } from '../../constants';
import {
  ASYNC_PAYMENT_EXPIRY_BLOCKS,
  ASYNC_PAYMENT_EXPIRY_MS,
  type PaymentDeliveryMode,
} from '../../types/payment';

export type ConditionalPaymentMode = Exclude<PaymentDeliveryMode, 'trusted'>;

export const resolvePaymentDeadlineWindow = (input: {
  mode: ConditionalPaymentMode;
  runtimeJHeight: number;
  timestamp: number;
  totalHops: number;
}): { baseTimelock: bigint; baseHeight: number } => {
  const minExpiryMs = input.totalHops * HTLC.MIN_TIMELOCK_DELTA_MS + HTLC.MIN_FORWARD_TIMELOCK_MS;
  const expiryMs = input.mode === 'async'
    ? Math.max(ASYNC_PAYMENT_EXPIRY_MS, minExpiryMs)
    : Math.max(120_000, minExpiryMs);
  const expiryBlocks = input.mode === 'async' ? ASYNC_PAYMENT_EXPIRY_BLOCKS : 50;
  return {
    baseTimelock: BigInt(input.timestamp + expiryMs),
    baseHeight: input.runtimeJHeight + expiryBlocks,
  };
};

export const requireTrustedPaymentGateway = (
  route: readonly string[],
  targetEntityId: string,
  declaredGatewayEntityId: string | undefined,
): string => {
  const routeTarget = route[route.length - 1];
  const routeGateway = route.length >= 3 ? route[route.length - 2] : undefined;
  if (routeTarget !== targetEntityId || !routeGateway || routeGateway !== declaredGatewayEntityId) {
    throw new Error(
      `TRUSTED_PAYMENT_GATEWAY_INVALID:declared=${declaredGatewayEntityId ?? ''}:` +
        `routeGateway=${routeGateway ?? ''}:routeTarget=${routeTarget ?? ''}:target=${targetEntityId}`,
    );
  }
  return routeGateway;
};
