import type { PaymentDeliveryMode } from '../../types/finance/payment';
import type { RuntimeInput } from '../../runtime/types';

type PaymentRouteQuote = { path: string[]; totalFee: bigint; senderAmount: bigint; recipientAmount: bigint };

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
  if (!['direct', 'trusted', 'instant', 'async'].includes(input.deliveryMode)) throw new Error('Invalid payment delivery mode');
  if (input.route.recipientAmount <= 0n || input.route.senderAmount < input.route.recipientAmount) throw new Error('Invalid payment amount');
  if (input.route.path.length < 2 || input.route.path[0]?.toLowerCase() !== input.entityId.toLowerCase() ||
    input.route.path.at(-1)?.toLowerCase() !== input.targetEntityId.toLowerCase()) throw new Error('Payment route endpoints mismatch');
  const isDirect = input.deliveryMode === 'direct';
  const isTrusted = input.deliveryMode === 'trusted';
  const usesDirectPayment = isDirect || isTrusted;
  const conditionalDeliveryMode = input.deliveryMode === 'instant' ? 'instant' as const : 'async' as const;
  const trustedGatewayEntityId = input.route.path.length === 3
    ? input.route.path[1]?.toLowerCase()
    : undefined;
  if (isTrusted && (!trustedGatewayEntityId || input.route.totalFee !== 0n)) {
    throw new Error('Trusted delivery requires exactly one fee-free gateway');
  }
  if (isDirect && input.route.path.length !== 2) {
    throw new Error('Direct delivery requires a bilateral route');
  }
  const routeTargetEntityId = input.targetEntityId.toLowerCase();
  return {
    runtimeTxs: [],
    entityInputs: [{
      entityId: input.entityId.toLowerCase(),
      signerId: input.signerId,
      entityTxs: usesDirectPayment
        ? [{
            type: 'directPayment',
            data: {
              targetEntityId: routeTargetEntityId,
              tokenId: input.tokenId,
              amount: input.route.recipientAmount,
              route: input.route.path.map(id => id.toLowerCase()),
              deliveryMode: isTrusted ? 'trusted' : 'direct',
              ...(isTrusted && trustedGatewayEntityId ? { trustedGatewayEntityId } : {}),
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
              route: input.route.path.map(id => id.toLowerCase()),
              deliveryMode: conditionalDeliveryMode,
              ...(description ? { description } : {}),
            },
          }],
    }],
    jInputs: [],
  };
};
