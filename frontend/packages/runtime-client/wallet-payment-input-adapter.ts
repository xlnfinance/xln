import type {
  PaymentDeliveryMode,
  RoutedEntityInput,
  RuntimeInput,
} from '@xln/runtime/api/public/runtime-module';

import { parseTokenAmountInput } from '$lib/components/Entity/token-amount-input';

const ENTITY_ID = /^0x[0-9a-f]{64}$/;

export type WalletPaymentDraft = Readonly<{
  entityId: string;
  signerId: string;
  targetEntityId: string;
  tokenId: number;
  tokenSymbol: string;
  tokenDecimals: number;
  amountInput: string;
  route: readonly string[];
  deliveryMode: PaymentDeliveryMode;
  totalFee: bigint;
  description?: string;
}>;

export type WalletPaymentPreview = Readonly<{
  entityId: string;
  targetEntityId: string;
  tokenId: number;
  tokenSymbol: string;
  amount: bigint;
  amountRaw: string;
  totalFeeRaw: string;
  route: readonly string[];
  deliveryMode: PaymentDeliveryMode;
  description: string;
}>;

export type WalletPaymentCommand = Readonly<{
  input: RuntimeInput;
  preview: WalletPaymentPreview;
}>;

const normalizeEntityId = (value: unknown, field: string): string => {
  const normalized = String(value || '').trim().toLowerCase();
  if (!ENTITY_ID.test(normalized)) throw new Error(`WALLET_PAYMENT_${field}_INVALID`);
  return normalized;
};
const normalizeRoute = (draft: WalletPaymentDraft, entityId: string, targetEntityId: string): string[] => {
  const route = draft.route.map((value, index) => normalizeEntityId(value, `ROUTE_${index}`));
  if (route.length < 2 || route[0] !== entityId || route.at(-1) !== targetEntityId) {
    throw new Error('WALLET_PAYMENT_ROUTE_ENDPOINT_MISMATCH');
  }
  if (new Set(route.slice(0, -1)).size !== route.length - 1) {
    throw new Error('WALLET_PAYMENT_ROUTE_CYCLE_INVALID');
  }
  if (draft.deliveryMode === 'direct' && route.length !== 2) {
    throw new Error('WALLET_PAYMENT_DIRECT_ROUTE_INVALID');
  }
  if (draft.deliveryMode === 'trusted' && (route.length !== 3 || draft.totalFee !== 0n)) {
    throw new Error('WALLET_PAYMENT_TRUSTED_ROUTE_INVALID');
  }
  return route;
};

export const buildWalletPaymentCommand = (draft: WalletPaymentDraft): WalletPaymentCommand => {
  const entityId = normalizeEntityId(draft.entityId, 'SOURCE');
  const signerId = String(draft.signerId || '').trim().toLowerCase();
  if (!signerId) throw new Error('WALLET_PAYMENT_SIGNER_MISSING');
  const targetEntityId = normalizeEntityId(draft.targetEntityId, 'TARGET');
  if (!Number.isSafeInteger(draft.tokenId) || draft.tokenId <= 0) {
    throw new Error('WALLET_PAYMENT_TOKEN_ID_INVALID');
  }
  const amount = parseTokenAmountInput(draft.amountInput, draft.tokenDecimals);
  const route = normalizeRoute(draft, entityId, targetEntityId);
  const description = String(draft.description || '').trim();
  const direct = draft.deliveryMode === 'direct' || draft.deliveryMode === 'trusted';
  const entityTx = direct
    ? {
        type: 'directPayment' as const,
        data: {
          targetEntityId,
          tokenId: draft.tokenId,
          amount,
          route,
          deliveryMode: draft.deliveryMode as 'direct' | 'trusted',
          ...(draft.deliveryMode === 'trusted' ? { trustedGatewayEntityId: route[1]! } : {}),
          ...(description ? { description } : {}),
        },
      }
    : {
        type: 'htlcPayment' as const,
        data: {
          targetEntityId,
          tokenId: draft.tokenId,
          amount,
          route,
          deliveryMode: draft.deliveryMode,
          ...(description ? { description } : {}),
        },
      };
  const entityInput: RoutedEntityInput = { entityId, signerId, entityTxs: [entityTx] };
  return Object.freeze({
    input: { runtimeTxs: [], entityInputs: [entityInput], jInputs: [] },
    preview: Object.freeze({
      entityId,
      targetEntityId,
      tokenId: draft.tokenId,
      tokenSymbol: String(draft.tokenSymbol || `token:${draft.tokenId}`),
      amount,
      amountRaw: amount.toString(),
      totalFeeRaw: draft.totalFee.toString(),
      route: Object.freeze(route),
      deliveryMode: draft.deliveryMode,
      description,
    }),
  });
};
