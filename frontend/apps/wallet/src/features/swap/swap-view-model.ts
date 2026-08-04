import type { SwapCommandPlan } from '@xln/runtime/api/public/runtime-module';

export type WalletSwapQuoteView = Readonly<{
  requestIdentity: string;
  offerId: string;
  mode: 'same' | 'cross';
  giveTokenId: number;
  wantTokenId: number;
  giveAmountRaw: string;
  wantAmountRaw: string;
  priceTicks: string;
  unspentGiveRaw: string;
  sourceOutCapacityRaw: string;
  feeEvidence: 'execution-bound';
  routeLabel: string;
}>;

const positiveTokenId = (value: unknown, code: string): number => {
  if (!Number.isSafeInteger(value) || Number(value) < 1) throw new Error(code);
  return Number(value);
};

const positiveAmount = (value: unknown, code: string): bigint => {
  if (typeof value !== 'bigint' || value <= 0n) throw new Error(code);
  return value;
};

const optionalNonNegativeAmount = (value: unknown, code: string): bigint | null => {
  if (value === undefined) return null;
  if (typeof value !== 'bigint' || value < 0n) throw new Error(code);
  return value;
};

const offerId = (value: unknown, code: string): string => {
  if (typeof value !== 'string' || !value.trim()) throw new Error(code);
  return value.trim();
};

export const projectWalletSwapQuote = (input: Readonly<{
  requestIdentity: string;
  giveTokenId: number;
  wantTokenId: number;
  routeLabel: string;
  plan: SwapCommandPlan;
}>): WalletSwapQuoteView => {
  if (!input.requestIdentity.trim()) throw new Error('WALLET_SWAP_QUOTE_IDENTITY_MISSING');
  if (!input.routeLabel.trim()) throw new Error('WALLET_SWAP_QUOTE_ROUTE_LABEL_MISSING');
  const prepared = input.plan.preparedOrder;
  return Object.freeze({
    requestIdentity: input.requestIdentity,
    offerId: offerId(input.plan.offerId, 'WALLET_SWAP_QUOTE_OFFER_ID_INVALID'),
    mode: input.plan.mode,
    giveTokenId: positiveTokenId(input.giveTokenId, 'WALLET_SWAP_QUOTE_GIVE_TOKEN_INVALID'),
    wantTokenId: positiveTokenId(input.wantTokenId, 'WALLET_SWAP_QUOTE_WANT_TOKEN_INVALID'),
    giveAmountRaw: positiveAmount(prepared.effectiveGive, 'WALLET_SWAP_QUOTE_GIVE_AMOUNT_INVALID').toString(),
    wantAmountRaw: positiveAmount(prepared.effectiveWant, 'WALLET_SWAP_QUOTE_WANT_AMOUNT_INVALID').toString(),
    priceTicks: positiveAmount(prepared.priceTicks, 'WALLET_SWAP_QUOTE_PRICE_INVALID').toString(),
    unspentGiveRaw: optionalNonNegativeAmount(prepared.unspentGiveAmount, 'WALLET_SWAP_QUOTE_DUST_INVALID')?.toString() ?? '0',
    sourceOutCapacityRaw: positiveAmount(input.plan.sourceOutCapacity, 'WALLET_SWAP_QUOTE_CAPACITY_INVALID').toString(),
    feeEvidence: 'execution-bound',
    routeLabel: input.routeLabel.trim(),
  });
};
