import { LIMITS } from '../config/constants';
import { toEntityId } from '../protocol/identity';

declare const OfferIdBrand: unique symbol;
declare const SwapKeyBrand: unique symbol;

export type OfferId = string & { readonly [OfferIdBrand]: typeof OfferIdBrand };
export type SwapKey = `${string}:${string}` & { readonly [SwapKeyBrand]: typeof SwapKeyBrand };

/**
 * Canonical peer-supplied offerId, enforced as a typed reject at Account
 * `swap_offer` admission in TS and Rust: 1..MAX_SWAP_OFFER_ID_LENGTH characters
 * of [A-Za-z0-9._-]. ASCII-only keeps TS UTF-16 order equal to Rust UTF-8 byte
 * order (book match order, dispute-proof order) and keeps
 * `${entityId}:${offerId}` within the 323-byte book page order id. Every
 * producer (swap command route, market maker, HLT, scenarios) emits this set.
 */
const CANONICAL_OFFER_ID = /^[A-Za-z0-9._-]+$/;

export const SWAP_OFFER_ID_REJECTION =
  `Invalid offerId: expected 1-${LIMITS.MAX_SWAP_OFFER_ID_LENGTH} characters of [A-Za-z0-9._-]`;

export const isCanonicalOfferId = (offerId: string): boolean =>
  offerId.length <= LIMITS.MAX_SWAP_OFFER_ID_LENGTH && CANONICAL_OFFER_ID.test(offerId);

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
