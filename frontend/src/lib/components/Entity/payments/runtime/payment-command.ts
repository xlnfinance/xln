import type {
  PaymentDeliveryMode,
  RuntimeInput,
} from '@xln/core/api/public/runtime-module';
import type { PaymentRouteQuote } from './payment-route-quote';

export const buildPaymentRuntimeInput = (input: Readonly<{
  entityId: string;
  signerId: string;
  targetEntityId: string;
  tokenId: number;
  deliveryMode: PaymentDeliveryMode;
  description: string;
  route: PaymentRouteQuote;
}>): RuntimeInput => {
  const description = input.description.trim();
  const isDirect = input.deliveryMode === 'direct';
  const isTrusted = input.deliveryMode === 'trusted';
  const usesDirectPayment = isDirect || isTrusted;
  const conditionalDeliveryMode = input.deliveryMode === 'instant' ? 'instant' as const : 'async' as const;
  const trustedGatewayEntityId = input.route.path.length === 3
    ? input.route.path[1]
    : undefined;
  if (isTrusted && (!trustedGatewayEntityId || input.route.totalFee !== 0n)) {
    throw new Error('Trusted delivery requires exactly one fee-free gateway');
  }
  if (isDirect && input.route.path.length !== 2) {
    throw new Error('Direct delivery requires a bilateral route');
  }
  const routeTargetEntityId = input.route.path[input.route.path.length - 1] || input.targetEntityId;
  return {
    runtimeTxs: [],
    entityInputs: [{
      entityId: input.entityId,
      signerId: input.signerId,
      entityTxs: usesDirectPayment
        ? [{
            type: 'directPayment',
            data: {
              targetEntityId: routeTargetEntityId,
              tokenId: input.tokenId,
              amount: input.route.recipientAmount,
              route: input.route.path,
              deliveryMode: isTrusted ? 'trusted' : 'direct',
              ...(isTrusted ? { trustedGatewayEntityId: trustedGatewayEntityId! } : {}),
              ...(description ? { description } : {}),
            },
          }]
        : [{
            type: 'htlcPayment',
            data: {
              targetEntityId: routeTargetEntityId,
              tokenId: input.tokenId,
              amount: input.route.recipientAmount,
              maxSenderDebit: input.route.senderAmount,
              route: input.route.path,
              deliveryMode: conditionalDeliveryMode,
              ...(description ? { description } : {}),
            },
          }],
    }],
    jInputs: [],
  };
};
