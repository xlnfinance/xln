import type { StorageAccountDoc } from '@xln/runtime/storage/types';

export type WalletSwapOrderStatus = 'open' | 'cancel-requested' | 'filled' | 'partial' | 'canceled' | 'closed';

export type WalletSwapOrderView = Readonly<{
  key: string;
  offerId: string;
  accountId: string;
  giveTokenId: number;
  wantTokenId: number;
  giveAmountRaw: string;
  wantAmountRaw: string;
  priceTicks: string;
  createdHeight: number;
  lastUpdatedHeight: number;
  status: WalletSwapOrderStatus;
  crossJurisdiction: boolean;
  executionGiveRaw: string;
  executionWantRaw: string;
  feeRaw: string;
  feeTokenId: number | null;
  closeComment: string | null;
}>;

export type WalletSwapViewDeps = Readonly<{
  computeSwapPriceTicks: (
    giveTokenId: number,
    wantTokenId: number,
    giveAmount: bigint,
    wantAmount: bigint,
  ) => bigint;
}>;

const positiveTokenId = (value: unknown, code: string): number => {
  if (!Number.isSafeInteger(value) || Number(value) < 1) throw new Error(code);
  return Number(value);
};

const positiveHeight = (value: unknown, code: string): number => {
  if (!Number.isSafeInteger(value) || Number(value) < 1) throw new Error(code);
  return Number(value);
};

const nonNegativeHeight = (value: unknown, code: string): number => {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new Error(code);
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

const resolveStatus = (input: Readonly<{
  cancelRequested: boolean;
  resolves: readonly {
    fillRatio: number;
    cancelRemainder: boolean;
    executionGiveAmount?: bigint;
    executionWantAmount?: bigint;
  }[];
  originalGiveAmount: bigint;
}>): WalletSwapOrderStatus => {
  let exactGive = 0n;
  let hasFill = false;
  let fullyFilled = false;
  let canceled = input.cancelRequested;
  for (const resolve of input.resolves) {
    if (!Number.isSafeInteger(resolve.fillRatio) || resolve.fillRatio < 0 || resolve.fillRatio > 65_535) {
      throw new Error(`WALLET_SWAP_RESOLVE_RATIO_INVALID:${resolve.fillRatio}`);
    }
    if (typeof resolve.cancelRemainder !== 'boolean') throw new Error('WALLET_SWAP_RESOLVE_CANCEL_INVALID');
    const give = optionalNonNegativeAmount(resolve.executionGiveAmount, 'WALLET_SWAP_RESOLVE_GIVE_INVALID');
    const want = optionalNonNegativeAmount(resolve.executionWantAmount, 'WALLET_SWAP_RESOLVE_WANT_INVALID');
    if ((give === null) !== (want === null)) throw new Error('WALLET_SWAP_RESOLVE_EXECUTION_INCOMPLETE');
    if ((give ?? 0n) > 0n) {
      hasFill = true;
      exactGive += give ?? 0n;
    }
    if (resolve.fillRatio > 0) hasFill = true;
    if (resolve.fillRatio === 65_535) fullyFilled = true;
    if (resolve.cancelRemainder) canceled = true;
  }
  if (fullyFilled || exactGive >= input.originalGiveAmount) return 'filled';
  if (hasFill) return 'partial';
  if (canceled) return 'canceled';
  return 'closed';
};

const priceFor = (
  entry: Readonly<{ giveTokenId: number; wantTokenId: number; giveAmount: bigint; wantAmount: bigint; priceTicks?: bigint }>,
  deps: WalletSwapViewDeps,
  code: string,
): bigint => entry.priceTicks !== undefined
  ? positiveAmount(entry.priceTicks, `${code}_PRICE_INVALID`)
  : positiveAmount(deps.computeSwapPriceTicks(entry.giveTokenId, entry.wantTokenId, entry.giveAmount, entry.wantAmount), `${code}_PRICE_INVALID`);

export const projectWalletSwapOrders = (
  account: StorageAccountDoc,
  accountId: string,
  deps: WalletSwapViewDeps,
): readonly WalletSwapOrderView[] => {
  const normalizedAccountId = accountId.trim().toLowerCase();
  if (!normalizedAccountId) throw new Error('WALLET_SWAP_ORDER_ACCOUNT_ID_MISSING');
  if (!(account.state.swapOffers instanceof Map)) throw new Error('WALLET_SWAP_OPEN_OFFERS_INVALID');
  if (account.swapOrderHistory !== undefined && !(account.swapOrderHistory instanceof Map)) throw new Error('WALLET_SWAP_ORDER_HISTORY_INVALID');
  if (account.swapClosedOrders !== undefined && !(account.swapClosedOrders instanceof Map)) throw new Error('WALLET_SWAP_CLOSED_ORDERS_INVALID');

  const history = account.swapOrderHistory ?? new Map();
  const rows = new Map<string, WalletSwapOrderView>();
  for (const [rawId, rawOffer] of account.state.swapOffers.entries()) {
    const currentOfferId = offerId(rawId, 'WALLET_SWAP_OPEN_OFFER_ID_INVALID');
    if (!rawOffer || typeof rawOffer !== 'object') throw new Error(`WALLET_SWAP_OPEN_OFFER_INVALID:${currentOfferId}`);
    const giveTokenId = positiveTokenId(rawOffer.giveTokenId, `WALLET_SWAP_OPEN_GIVE_TOKEN_INVALID:${currentOfferId}`);
    const wantTokenId = positiveTokenId(rawOffer.wantTokenId, `WALLET_SWAP_OPEN_WANT_TOKEN_INVALID:${currentOfferId}`);
    const giveAmount = positiveAmount(rawOffer.giveAmount, `WALLET_SWAP_OPEN_GIVE_INVALID:${currentOfferId}`);
    const wantAmount = positiveAmount(rawOffer.wantAmount, `WALLET_SWAP_OPEN_WANT_INVALID:${currentOfferId}`);
    const lifecycle = history.get(currentOfferId);
    const cancelRequested = lifecycle?.cancelRequested ?? false;
    if (typeof cancelRequested !== 'boolean') throw new Error(`WALLET_SWAP_CANCEL_STATE_INVALID:${currentOfferId}`);
    rows.set(currentOfferId, Object.freeze({
      key: `${normalizedAccountId}:${currentOfferId}`, offerId: currentOfferId, accountId: normalizedAccountId,
      giveTokenId, wantTokenId, giveAmountRaw: giveAmount.toString(), wantAmountRaw: wantAmount.toString(),
      priceTicks: priceFor({ ...rawOffer, giveTokenId, wantTokenId, giveAmount, wantAmount }, deps, 'WALLET_SWAP_OPEN').toString(),
      createdHeight: positiveHeight(rawOffer.createdHeight, `WALLET_SWAP_OPEN_HEIGHT_INVALID:${currentOfferId}`),
      lastUpdatedHeight: lifecycle ? nonNegativeHeight(lifecycle.lastUpdatedHeight, `WALLET_SWAP_HISTORY_HEIGHT_INVALID:${currentOfferId}`) : positiveHeight(rawOffer.createdHeight, `WALLET_SWAP_OPEN_HEIGHT_INVALID:${currentOfferId}`),
      status: cancelRequested ? 'cancel-requested' : 'open', crossJurisdiction: rawOffer.crossJurisdiction !== undefined,
      executionGiveRaw: '0', executionWantRaw: '0', feeRaw: '0', feeTokenId: null, closeComment: null,
    }));
  }

  for (const [rawId, rawEntry] of (account.swapClosedOrders ?? new Map()).entries()) {
    const currentOfferId = offerId(rawId, 'WALLET_SWAP_CLOSED_OFFER_ID_INVALID');
    if (!rawEntry || typeof rawEntry !== 'object') throw new Error(`WALLET_SWAP_CLOSED_OFFER_INVALID:${currentOfferId}`);
    const giveTokenId = positiveTokenId(rawEntry.giveTokenId, `WALLET_SWAP_CLOSED_GIVE_TOKEN_INVALID:${currentOfferId}`);
    const wantTokenId = positiveTokenId(rawEntry.wantTokenId, `WALLET_SWAP_CLOSED_WANT_TOKEN_INVALID:${currentOfferId}`);
    const originalGiveAmount = positiveAmount(rawEntry.originalGiveAmount ?? rawEntry.giveAmount, `WALLET_SWAP_CLOSED_GIVE_INVALID:${currentOfferId}`);
    const originalWantAmount = positiveAmount(rawEntry.originalWantAmount ?? rawEntry.wantAmount, `WALLET_SWAP_CLOSED_WANT_INVALID:${currentOfferId}`);
    if (!Array.isArray(rawEntry.resolves)) throw new Error(`WALLET_SWAP_RESOLVES_INVALID:${currentOfferId}`);
    let executionGive = 0n;
    let executionWant = 0n;
    let fee = 0n;
    let feeTokenId: number | null = null;
    let closeComment: string | null = null;
    for (const resolve of rawEntry.resolves) {
      if (!resolve || typeof resolve !== 'object') throw new Error(`WALLET_SWAP_RESOLVE_INVALID:${currentOfferId}`);
      positiveHeight(resolve.height, `WALLET_SWAP_RESOLVE_HEIGHT_INVALID:${currentOfferId}`);
      const exactGive = optionalNonNegativeAmount(resolve.executionGiveAmount, `WALLET_SWAP_RESOLVE_GIVE_INVALID:${currentOfferId}`);
      const exactWant = optionalNonNegativeAmount(resolve.executionWantAmount, `WALLET_SWAP_RESOLVE_WANT_INVALID:${currentOfferId}`);
      if ((exactGive === null) !== (exactWant === null)) throw new Error(`WALLET_SWAP_RESOLVE_EXECUTION_INCOMPLETE:${currentOfferId}`);
      executionGive += exactGive ?? 0n;
      executionWant += exactWant ?? 0n;
      const resolveFee = optionalNonNegativeAmount(resolve.feeAmount, `WALLET_SWAP_RESOLVE_FEE_INVALID:${currentOfferId}`) ?? 0n;
      if (resolveFee > 0n) {
        const nextFeeToken = positiveTokenId(resolve.feeTokenId, `WALLET_SWAP_RESOLVE_FEE_TOKEN_INVALID:${currentOfferId}`);
        if (feeTokenId !== null && feeTokenId !== nextFeeToken) throw new Error(`WALLET_SWAP_RESOLVE_FEE_TOKEN_CONFLICT:${currentOfferId}`);
        feeTokenId = nextFeeToken;
        fee += resolveFee;
      }
      if (resolve.comment !== undefined) {
        if (typeof resolve.comment !== 'string') throw new Error(`WALLET_SWAP_RESOLVE_COMMENT_INVALID:${currentOfferId}`);
        if (resolve.comment.trim()) closeComment = resolve.comment.trim();
      }
    }
    rows.set(currentOfferId, Object.freeze({
      key: `${normalizedAccountId}:${currentOfferId}`, offerId: currentOfferId, accountId: normalizedAccountId,
      giveTokenId, wantTokenId, giveAmountRaw: originalGiveAmount.toString(), wantAmountRaw: originalWantAmount.toString(),
      priceTicks: priceFor({ giveTokenId, wantTokenId, giveAmount: originalGiveAmount, wantAmount: originalWantAmount, ...(rawEntry.priceTicks !== undefined ? { priceTicks: rawEntry.priceTicks } : {}) }, deps, 'WALLET_SWAP_CLOSED').toString(),
      createdHeight: positiveHeight(rawEntry.createdHeight, `WALLET_SWAP_CLOSED_CREATED_HEIGHT_INVALID:${currentOfferId}`),
      lastUpdatedHeight: positiveHeight(rawEntry.lastUpdatedHeight, `WALLET_SWAP_CLOSED_UPDATED_HEIGHT_INVALID:${currentOfferId}`),
      status: resolveStatus({ cancelRequested: rawEntry.cancelRequested, resolves: rawEntry.resolves, originalGiveAmount }),
      crossJurisdiction: rawEntry.crossJurisdiction !== undefined,
      executionGiveRaw: executionGive.toString(), executionWantRaw: executionWant.toString(), feeRaw: fee.toString(), feeTokenId, closeComment,
    }));
  }
  return Object.freeze([...rows.values()].toSorted((left, right) =>
    right.lastUpdatedHeight - left.lastUpdatedHeight || right.createdHeight - left.createdHeight || left.key.localeCompare(right.key)
  ));
};
