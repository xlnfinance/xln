
import { HTLC_ENFORCEMENT_RESERVE_MS, HTLC } from '../../config/constants';
import { rejectFailure } from '../errors/failure-taxonomy';
import {
  paymentExpiryBlocks,
  ASYNC_PAYMENT_EXPIRY_MS,
  type PaymentDeliveryMode,
} from '../../types/finance/payment';
import { toJHeight, type JHeight, type UnixMs } from '../units';

type ConditionalPaymentMode = Extract<PaymentDeliveryMode, 'instant' | 'async'>;

export const resolvePaymentDeadlineWindow = (input: {
  mode: ConditionalPaymentMode;
  runtimeJHeight: JHeight;
  timestamp: UnixMs;
  totalHops: number;
  blockTimeMs: number | undefined;
}): { baseTimelock: bigint; baseHeight: JHeight } => {
  const minExpiryMs = input.totalHops * HTLC.MIN_TIMELOCK_DELTA_MS + HTLC_ENFORCEMENT_RESERVE_MS + HTLC.MIN_TIMELOCK_DELTA_MS;
  const expiryMs = input.mode === 'async'
    ? Math.max(ASYNC_PAYMENT_EXPIRY_MS, minExpiryMs)
    : Math.max(120_000, minExpiryMs);
  const expiryBlocks = paymentExpiryBlocks(expiryMs, input.blockTimeMs);
  return {
    baseTimelock: BigInt(input.timestamp + expiryMs),
    baseHeight: toJHeight(input.runtimeJHeight + expiryBlocks),
  };
};

export const requireTrustedPaymentGateway = (
  route: readonly string[],
  targetEntityId: string,
  declaredGatewayEntityId: string | undefined,
): string => {
  const routeTarget = route[route.length - 1];
  const routeGateway = route.length === 3 ? route[1] : undefined;
  const routeSource = route[0];
  if (
    routeTarget !== targetEntityId
    || !routeGateway
    || routeGateway !== declaredGatewayEntityId
    || routeGateway === routeSource
    || routeGateway === routeTarget
  ) {
    throw rejectFailure('TRUSTED_PAYMENT_GATEWAY_INVALID',
      `TRUSTED_PAYMENT_GATEWAY_INVALID:declared=${declaredGatewayEntityId ?? ''}:` +
        `routeGateway=${routeGateway ?? ''}:routeTarget=${routeTarget ?? ''}:target=${targetEntityId}`,
    );
  }
  return routeGateway;
};
