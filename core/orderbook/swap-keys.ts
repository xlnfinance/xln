import { LIMITS } from '../config/constants';
import { toEntityId } from '../protocol/identity';

declare const OfferIdBrand: unique symbol;
declare const SwapKeyBrand: unique symbol;

export type OfferId = string & { readonly [OfferIdBrand]: typeof OfferIdBrand };
export type SwapKey = `${string}:${string}` & { readonly [SwapKeyBrand]: typeof SwapKeyBrand };

export function asOfferId(value: string): OfferId {
  const normalized = String(value);
  if (
    normalized.length === 0
    || normalized.length > LIMITS.MAX_SWAP_OFFER_ID_LENGTH
    || normalized.includes(':')
  ) {
    throw new Error(`SWAP_OFFER_ID_INVALID:${normalized.length}`);
  }
  return normalized as OfferId;
}

export function swapKey(accountId: string, offerId: string): SwapKey {
  const account = toEntityId(String(accountId));
  return `${account}:${asOfferId(offerId)}` as SwapKey;
}

export function compareCanonicalText(left: string, right: string): number {
  const a = String(left || '');
  const b = String(right || '');
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}
